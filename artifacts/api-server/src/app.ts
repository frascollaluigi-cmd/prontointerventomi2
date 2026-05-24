import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import router from "./routes";
import { logger } from "./lib/logger";
import { db, richiesteTable, tecniciTable, impostazioniTable, tosAuditTable } from "@workspace/db";
import { desc, eq, sql } from "drizzle-orm";
import { registerClienteRoutes } from "./cliente";
import { creaCheckoutUscita, registerStripeRoutes, stripeEnabled, stripeWebhookHandler, catturaPagamento, annullaPagamento } from "./stripe";
import { notificheConfigurate, notificaTecnicoNuovaRichiesta, notificaClienteTecnicoAccettato, notificaAdmin, inviaEmailCliente, inviaRichiestaRecensione } from "./notifiche";
import { sendPushNotification } from "./push";

const app: Express = express();

// ── DISPONIBILITÀ GLOBALE (persistita nel DB) ──────────────────
let tecnicoDisponibile = true;

async function caricaDisponibilita(): Promise<void> {
  try {
    const [row] = await db.select().from(impostazioniTable).where(eq(impostazioniTable.chiave, "tecnico_disponibile"));
    if (row) tecnicoDisponibile = row.valore === "true";
  } catch (e) {
    logger.warn({ err: e }, "Impossibile caricare disponibilità dal DB, uso default true");
  }
}

async function salvaDisponibilita(valore: boolean): Promise<void> {
  await db.insert(impostazioniTable)
    .values({ chiave: "tecnico_disponibile", valore: String(valore) })
    .onConflictDoUpdate({ target: impostazioniTable.chiave, set: { valore: String(valore), aggiornatoAt: new Date() } });
}

const METRO_PORT = 23994;
const METRO_PREFIXES = [
  "/node_modules",
  "/_expo",
  "/assets",
  "/src",
  "/index.bundle",
  "/symbolicate",
  "/inspector",
  "/logs",
  "/hot",
  "/debugger-frontend",
];

function proxyToMetro(req: Request, res: Response): void {
  const headers = { ...req.headers };
  delete headers["origin"];
  delete headers["referer"];
  const proxyReq = http.request(
    {
      hostname: "localhost",
      port: METRO_PORT,
      path: req.originalUrl,
      method: req.method,
      headers: { ...headers, host: `localhost:${METRO_PORT}` },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on("error", () => {
    if (!res.headersSent) res.status(502).send("Metro bundler not reachable");
  });
  req.pipe(proxyReq);
}

app.use((req, res, next) => {
  if (METRO_PREFIXES.some((p) => req.path === p || req.path.startsWith(p + "/") || req.path.startsWith(p + "?"))) {
    proxyToMetro(req, res);
    return;
  }
  next();
});

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) { return { id: req.id, method: req.method, url: req.url?.split("?")[0] }; },
      res(res) { return { statusCode: res.statusCode }; },
    },
  }),
);
app.use(cors());

// Trust proxy per ottenere IP reale del client dietro il reverse-proxy Replit
app.set("trust proxy", true);

// Versione corrente dei Termini di Servizio (usata per audit accettazioni)
const TOS_VERSION = "v1.0-2026-04-25";

// Serve static assets
app.use(express.static(path.join(__dirname, "../public")));

// Serve PWA app tecnico (build statico Expo) sotto /tecnico con SPA fallback
// In produzione i file vengono copiati dentro dist/tecnico-web durante il build (vedi build.mjs)
// In dev fallback sulla dir originale dell'app expo
const TECNICO_DIST_PROD = path.resolve(__dirname, "tecnico-web");
const TECNICO_DIST_DEV = path.resolve(__dirname, "../../app-tecnico/dist-web");
const TECNICO_DIST = fs.existsSync(TECNICO_DIST_PROD) ? TECNICO_DIST_PROD : TECNICO_DIST_DEV;
if (fs.existsSync(TECNICO_DIST)) {
  app.use("/tecnico", express.static(TECNICO_DIST, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".webmanifest")) res.setHeader("Content-Type", "application/manifest+json");
    },
  }));
  app.get(/^\/tecnico(\/.*)?$/, (_req, res) => {
    res.sendFile(path.join(TECNICO_DIST, "index.html"));
  });
  logger.info({ TECNICO_DIST }, "App tecnico PWA servita su /tecnico");
}

// Stripe webhook: deve ricevere il body grezzo per la verifica della firma — va registrato PRIMA di express.json()
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), stripeWebhookHandler);

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

const SERVIZIO_LABEL: Record<string, string> = {
  impianti_elettrici: "Impianti elettrici",
  allarmi: "Allarmi",
  automazione_cancelli: "Automazione cancelli",
  citofoni: "Citofoni",
  antenne: "Antenne",
};

const FASCIA_LABEL: Record<string, string> = {
  standard: "Standard (entro 4 ore)",
  urgente: "Urgente (entro 1,5 ore)",
  notte_festivo: "Dopo le 17 / Festivi",
  prioritario: "Intervento Prioritario Locali (entro 90 min + Assistenza AI)",
};

const LISTINO: Record<string, Record<string, number>> = {
  impianti_elettrici:   { standard: 7000, urgente: 12000, notte_festivo: 20000, prioritario: 35000 },
  allarmi:              { standard: 7000, urgente: 12000, notte_festivo: 20000, prioritario: 35000 },
  automazione_cancelli: { standard: 7000, urgente: 12000, notte_festivo: 20000, prioritario: 35000 },
  citofoni:             { standard: 7000, urgente: 12000, notte_festivo: 20000, prioritario: 35000 },
  antenne:              { standard: 7000, urgente: 12000, notte_festivo: 20000, prioritario: 35000 },
};

const FEE_PIATTAFORMA = 0.35;

function calcolaPrezzo(servizio: string, fascia: string): number {
  return LISTINO[servizio]?.[fascia] ?? 5900;
}

function eur(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",") + " €";
}

/* Calcola fascia italiana lato server (Node ≥ 18 supporta Intl con timeZone) */
const FESTIVITA_SERVER = new Set([
  '01-01','01-06','04-05','04-06','04-25','05-01','06-02',
  '08-15','11-01','12-08','12-25','12-26',
]);
function serverFasciaFestiva(): boolean {
  const n = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const obj: Record<string, string> = {};
  fmt.formatToParts(n).forEach(p => { obj[p.type] = p.value; });
  const dow = new Date(Number(obj.year), Number(obj.month) - 1, Number(obj.day)).getDay();
  const h   = Number(obj.hour);
  const key = `${obj.month}-${obj.day}`;
  const isFestivita   = FESTIVITA_SERVER.has(key);
  const isWeekday     = dow >= 1 && dow <= 5 && !isFestivita;
  const isOrarioDiurno = h >= 8 && h < 17;
  return !(isWeekday && isOrarioDiurno);   // true = serale/festivo
}

function esc(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SERVIZI_VALIDI = new Set(Object.keys(SERVIZIO_LABEL));
const FASCE_VALIDE = new Set(Object.keys(FASCIA_LABEL));
const CAP_REGEX = /^[0-9]{5}$/;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "prontoIntervento2026";

function adminAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="prontointerventomi.it Admin"');
    return res.status(401).send("Autenticazione richiesta");
  }
  const [, b64] = auth.split(" ");
  const [user, pass] = Buffer.from(b64, "base64").toString("utf8").split(":");
  if (user !== "admin" || pass !== ADMIN_PASSWORD) {
    res.setHeader("WWW-Authenticate", 'Basic realm="prontointerventomi.it Admin"');
    return res.status(401).send("Credenziali non valide");
  }
  next();
}

const STATO_LABEL: Record<string, { txt: string; bg: string; col: string }> = {
  in_attesa:      { txt: "In attesa",         bg: "#fef3c7", col: "#92400e" },
  assegnata:      { txt: "Assegnata",         bg: "#dbeafe", col: "#1e40af" },
  accettata:      { txt: "Accettata",         bg: "#d1fae5", col: "#065f46" },
  completata:     { txt: "Completata",        bg: "#e0e7ff", col: "#3730a3" },
  autorizzata:    { txt: "💳 Carta autorizzata", bg: "#fef9c3", col: "#713f12" },
  pagata:         { txt: "✅ Pagata",          bg: "#dcfce7", col: "#166534" },
  auth_annullata: { txt: "💵 Pagato in contanti", bg: "#f0fdf4", col: "#166534" },
  annullata:      { txt: "Annullata",         bg: "#fee2e2", col: "#991b1b" },
};

const HTML_PAGE = `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Elettricista Urgente Milano — Intervento in 90 min | prontointerventomi.it</title>
<meta name="description" content="Elettricista urgente a Milano: arrivo entro 60–90 minuti, H24, prezzi fissi. Impianti elettrici, allarmi, citofoni, antenne, cancelli. Prenota online — prontointerventomi.it"/>
<meta name="keywords" content="elettricista urgente Milano, pronto intervento elettrico Milano, guasto elettrico Milano, elettricista H24 Milano, elettricista notturno Milano"/>
<meta name="robots" content="index, follow"/>
<link rel="canonical" href="https://prontointerventomi.it/"/>
<!-- Open Graph -->
<meta property="og:type" content="website"/>
<meta property="og:url" content="https://prontointerventomi.it/"/>
<meta property="og:title" content="Elettricista Urgente Milano — Intervento in 90 min"/>
<meta property="og:description" content="Arrivo entro 60–90 minuti, H24, prezzi fissi. Impianti elettrici, allarmi, citofoni, antenne, cancelli automatici."/>
<meta property="og:image" content="https://prontointerventomi.it/hero-bg.png"/>
<meta property="og:locale" content="it_IT"/>
<meta property="og:site_name" content="Pronto Intervento Milano"/>
<!-- Twitter Card -->
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="Elettricista Urgente Milano — 90 min"/>
<meta name="twitter:description" content="Arrivo entro 60–90 min, H24, prezzi fissi. Prenota online."/>
<meta name="twitter:image" content="https://prontointerventomi.it/hero-bg.png"/>
<!-- PWA -->
<link rel="manifest" href="/manifest.json"/>
<meta name="theme-color" content="#dc2626"/>
<meta name="apple-mobile-web-app-capable" content="yes"/>
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"/>
<meta name="apple-mobile-web-app-title" content="ProntoMI"/>
<link rel="apple-touch-icon" href="/pim-logo.png"/>
<!-- Schema.org LocalBusiness -->
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "LocalBusiness",
  "name": "Pronto Intervento Milano — by ELETTROTECH",
  "description": "Elettricista urgente a Milano. Intervento in 60-90 minuti, H24, prezzi fissi.",
  "url": "https://prontointerventomi.it",
  "telephone": "+393405707813",
  "priceRange": "€€",
  "currenciesAccepted": "EUR",
  "paymentAccepted": "Credit Card, Cash",
  "openingHours": "Mo-Su 00:00-24:00",
  "areaServed": { "@type": "City", "name": "Milano" },
  "address": { "@type": "PostalAddress", "addressLocality": "Milano", "addressRegion": "MI", "addressCountry": "IT" },
  "image": "https://prontointerventomi.it/hero-bg.png",
  "sameAs": [],
  "hasOfferCatalog": {
    "@type": "OfferCatalog",
    "name": "Servizi di pronto intervento elettrico",
    "itemListElement": [
      { "@type": "Offer", "name": "Intervento Standard", "price": "70", "priceCurrency": "EUR" },
      { "@type": "Offer", "name": "Intervento Urgente (90 min)", "price": "120", "priceCurrency": "EUR" },
      { "@type": "Offer", "name": "Intervento Serale/Festivo", "price": "200", "priceCurrency": "EUR" }
    ]
  }
}
<\/script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --red:#dc2626;--red2:#b91c1c;
  --green:#16a34a;--green2:#15803d;
  --orange:#ea580c;
  --navy:#0f2244;--navy2:#1e3a5f;
  --bg:#d4b98a;--bg2:#c8aa78;
  --white:#ffffff;
  --text:#0f172a;--muted:#4b5563;--light:#8898aa;
  --border:#e4d9c8;
  --radius:12px;--max:680px
}
html{scroll-behavior:smooth}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased;padding-bottom:76px}

/* ── NAV ── */
nav{position:absolute;top:0;left:0;right:0;z-index:200;background:linear-gradient(to bottom,rgba(0,0,0,.45) 0%,rgba(0,0,0,.18) 70%,transparent 100%);border-bottom:none;padding:.85rem 1.4rem 1.6rem;display:flex;align-items:center;gap:.9rem}
.nav-logo{display:flex;align-items:center;gap:.6rem;text-decoration:none;flex-shrink:0}
.nav-logo-img{width:44px;height:44px;flex-shrink:0;object-fit:contain;filter:drop-shadow(0 2px 6px rgba(0,0,0,.5))}
.nav-text{line-height:1.2}
.nav-name{font-size:.85rem;font-weight:800;color:#ffffff;letter-spacing:-.2px;display:block;text-shadow:0 1px 4px rgba(0,0,0,.6)}
.nav-elettro{font-size:.6rem;font-weight:600;color:rgba(255,255,255,.85);letter-spacing:.5px;text-transform:uppercase;display:block;text-shadow:0 1px 3px rgba(0,0,0,.5)}
.nav-spacer{flex:1}
.nav-tel{display:inline-flex;align-items:center;gap:.3rem;color:#ffffff;text-decoration:none;font-size:.82rem;font-weight:700;white-space:nowrap;transition:color .15s;text-shadow:0 1px 4px rgba(0,0,0,.6)}
.nav-tel:hover{color:#fbbf24}
.btn-red{display:inline-flex;align-items:center;background:var(--red);color:#fff;text-decoration:none;padding:.5rem 1rem;border-radius:2rem;font-size:.78rem;font-weight:800;letter-spacing:.2px;text-transform:uppercase;white-space:nowrap;transition:background .15s,transform .1s;box-shadow:0 3px 10px rgba(220,38,38,.3)}
.btn-red:hover{background:var(--red2);transform:translateY(-1px)}
.btn-green{display:inline-flex;align-items:center;background:var(--green);color:#fff;text-decoration:none;padding:.5rem 1rem;border-radius:2rem;font-size:.78rem;font-weight:800;letter-spacing:.2px;text-transform:uppercase;white-space:nowrap;transition:background .15s,transform .1s;box-shadow:0 3px 10px rgba(22,163,74,.3)}
.btn-green:hover{background:var(--green2);transform:translateY(-1px)}
.lbl-mob{display:none}
@media(max-width:540px){
  .nav-tel{display:none}
  .lbl-full{display:none}
  .lbl-mob{display:inline}
  nav{padding:.7rem .8rem 1.4rem;gap:.5rem}
  .nav-logo{gap:.4rem}
  .nav-logo-img{width:36px;height:36px}
  .nav-name{font-size:.72rem}
  .nav-elettro{font-size:.52rem}
  .btn-red,.btn-green{padding:.5rem .75rem;font-size:.7rem;letter-spacing:0}
  .btn-green svg{width:13px;height:13px}
}
@media(max-width:380px){
  .nav-text{display:none}
  .btn-red,.btn-green{padding:.45rem .6rem;font-size:.65rem}
}

/* ── HERO ── */
.hero{
  position:relative;overflow:hidden;
  padding:2.8rem 1.4rem 2.4rem;
  text-align:center;
  border-bottom:none;
  background:transparent;
  min-height:auto;
}
/* foto di sfondo su pseudo-element con filtro luminosità */
.hero::before{
  content:'';
  position:absolute;inset:0;z-index:0;
  background:url('/hero-bg.png') 70% top/cover no-repeat;
  filter:brightness(1.55) saturate(1.1);
}
@media(min-width:700px){
  .hero::before{background-position:right top}
}
@media(max-width:699px){
  .hero{min-height:100vh;padding:4.5rem 1rem 1.5rem}
  .hero::before{background-position:78% center;background-size:cover}
  .hero-logo-wrap{display:none}
  .hero h1{font-size:clamp(1.7rem,7vw,2.4rem)}
  .hero-sub{font-size:.85rem}
}
/* overlay scuro leggero sopra la foto */
.hero::after{
  content:'';
  position:absolute;inset:0;z-index:1;
  background:linear-gradient(to bottom,rgba(5,12,28,.22) 0%,rgba(5,12,28,.10) 55%,rgba(5,12,28,.06) 100%);
}
/* tutto il contenuto sopra gli pseudo-elementi */
.hero-inner{position:relative;z-index:2}
/* layout desktop: testo a sinistra, foto leggibile a destra */
@media(min-width:700px){
  .hero{
    padding:3.5rem 2.5rem 3rem;
    text-align:left;
  }
  .hero::after{
    background:linear-gradient(to right,rgba(5,12,28,.50) 0%,rgba(5,12,28,.20) 42%,rgba(5,12,28,.02) 100%);
  }
  .hero-inner{max-width:580px}
  .avail-tag,.price-avail-label{margin-left:0}
  .price-cards{margin-left:0;margin-right:auto}
  .hero-pay-cta{margin-left:0;margin-right:auto}
  .hero-btns{justify-content:flex-start}
  .hero-trust{justify-content:flex-start}
  .hero-sub{margin-left:0;margin-right:0}
}
.hero-logo-wrap{margin-bottom:1rem}
.hero-logo-wrap img{width:100px;height:100px;object-fit:contain;filter:drop-shadow(0 4px 16px rgba(0,0,0,.4))brightness(1.1)}
.avail-tag{display:inline-flex;align-items:center;gap:.5rem;background:rgba(34,197,94,.18);border:1px solid rgba(34,197,94,.45);border-radius:2rem;padding:.35rem 1rem;font-size:.72rem;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:#86efac;margin-bottom:1rem}
.avail-dot{width:8px;height:8px;background:#22c55e;border-radius:50%;animation:blink 1.5s infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.2}}
.hero h1{font-size:clamp(2rem,6.5vw,3.4rem);font-weight:900;letter-spacing:-1.5px;line-height:1.08;margin-bottom:.75rem;color:#ffffff;position:relative;z-index:1;text-shadow:0 2px 8px rgba(0,0,0,.9),0 4px 24px rgba(0,0,0,.7)}
.hero h1 .hl{color:#fbbf24}
.hero-sub{font-size:.94rem;color:rgba(255,255,255,.92);line-height:1.7;max-width:520px;margin:0 auto 1.4rem;position:relative;z-index:1;text-shadow:0 1px 6px rgba(0,0,0,.8)}
.hero-sub strong{color:#ffffff}
.hero-btns{display:flex;align-items:center;justify-content:center;gap:.8rem;flex-wrap:wrap;position:relative;z-index:1;margin-bottom:1.2rem}
.h-btn-red{display:inline-flex;align-items:center;gap:.4rem;background:var(--red);color:#fff;text-decoration:none;padding:1rem 1.8rem;border-radius:3rem;font-size:1rem;font-weight:800;letter-spacing:.1px;box-shadow:0 8px 24px rgba(220,38,38,.45);transition:transform .15s,box-shadow .15s;text-transform:uppercase}
.h-btn-red:hover{transform:translateY(-2px);box-shadow:0 12px 32px rgba(220,38,38,.6)}
.h-btn-green{display:inline-flex;align-items:center;gap:.4rem;background:var(--green);color:#fff;text-decoration:none;padding:1rem 1.8rem;border-radius:3rem;font-size:1rem;font-weight:800;letter-spacing:.1px;box-shadow:0 8px 24px rgba(22,163,74,.4);transition:transform .15s,box-shadow .15s;text-transform:uppercase}
.h-btn-green:hover{transform:translateY(-2px);box-shadow:0 12px 32px rgba(22,163,74,.55)}
.h-btn-pay{display:inline-flex;align-items:center;gap:.5rem;background:linear-gradient(135deg,#f59e0b,#d97706);color:#fff;text-decoration:none;padding:1.1rem 2.2rem;border-radius:3rem;font-size:1.05rem;font-weight:900;letter-spacing:.2px;box-shadow:0 8px 28px rgba(245,158,11,.55);transition:transform .15s,box-shadow .15s;text-transform:uppercase;margin-bottom:.8rem}
.h-btn-pay:hover{transform:translateY(-2px);box-shadow:0 14px 36px rgba(245,158,11,.7)}
.hero-trust{display:flex;justify-content:center;gap:.8rem;flex-wrap:wrap;margin-top:.9rem}
.hero-trust span{display:inline-flex;align-items:center;gap:.3rem;font-size:.72rem;font-weight:700;color:rgba(255,255,255,.9);background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.22);border-radius:2rem;padding:.3rem .85rem;backdrop-filter:blur(8px)}

/* ── PRICE CARDS ── */
.price-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:.6rem;margin:1.1rem auto .4rem;max-width:520px;position:relative;z-index:1;width:100%}
.price-card{background:#fff;border:2px solid var(--border);border-radius:14px;padding:1rem .7rem .85rem;cursor:pointer;transition:all .18s;text-align:center;position:relative;user-select:none;-webkit-user-select:none}
.price-card:hover{border-color:#fca5a5;transform:translateY(-2px);box-shadow:0 6px 20px rgba(0,0,0,.09)}
.price-card.selected{border-color:var(--red);background:#fff8f8;box-shadow:0 0 0 3px rgba(220,38,38,.11),0 4px 16px rgba(220,38,38,.12)}
.price-card.rec{border-color:var(--orange)}
.price-card.rec.selected{border-color:var(--orange);background:#fffbf0;box-shadow:0 0 0 3px rgba(234,88,12,.15),0 4px 16px rgba(234,88,12,.15)}
.rec-badge{display:block;background:var(--orange);color:#fff;font-size:.52rem;font-weight:900;letter-spacing:.6px;text-transform:uppercase;border-radius:2rem;padding:.2rem .55rem;margin:0 auto .5rem;width:fit-content}
.price-card-name{font-size:.62rem;font-weight:900;letter-spacing:.7px;text-transform:uppercase;color:var(--navy);margin-bottom:.2rem;line-height:1.2}
.price-card-time{font-size:.6rem;color:var(--muted);margin-bottom:.5rem;font-weight:500;line-height:1.3}
.price-card-amt{font-size:1.45rem;font-weight:900;color:var(--navy);letter-spacing:-.5px;line-height:1}
.price-card.rec .price-card-amt{color:var(--orange)}
.price-card.selected:not(.rec) .price-card-name{color:var(--red)}
.price-card.rec.selected .price-card-name{color:var(--orange)}
.price-check{position:absolute;top:6px;right:8px;font-size:.7rem;opacity:0;transition:opacity .15s}
.price-card.selected .price-check{opacity:1}
.hero-pay-cta{display:flex;align-items:center;justify-content:center;gap:.55rem;width:100%;max-width:520px;margin:.65rem auto .5rem;background:linear-gradient(135deg,#f59e0b,#d97706);color:#fff;text-decoration:none;padding:1.15rem 1.5rem;border-radius:13px;font-size:1.1rem;font-weight:900;letter-spacing:.2px;box-shadow:0 8px 26px rgba(245,158,11,.42);transition:transform .15s,box-shadow .15s;text-transform:uppercase;cursor:pointer;position:relative;z-index:1}
.hero-pay-cta:hover{transform:translateY(-2px);box-shadow:0 14px 36px rgba(245,158,11,.58)}
.hero-pay-cta:active{transform:scale(.97)}
@media(max-width:400px){.price-card-amt{font-size:1.2rem}.price-card{padding:.8rem .45rem .7rem}.price-card-name{font-size:.56rem}.rec-badge{font-size:.48rem}}
.price-card.unavail{display:none!important}
.price-avail-label{display:inline-flex;align-items:center;gap:.35rem;font-size:.65rem;font-weight:700;border-radius:2rem;padding:.25rem .65rem;margin:0 auto .6rem;width:fit-content;position:relative;z-index:1}
.price-avail-label.day{background:rgba(34,197,94,.18);color:#86efac;border:1px solid rgba(34,197,94,.35)}
.price-avail-label.night{background:rgba(96,165,250,.18);color:#93c5fd;border:1px solid rgba(96,165,250,.35)}
/* ── TOAST ── */
.price-toast{position:fixed;bottom:calc(80px + env(safe-area-inset-bottom));left:50%;transform:translateX(-50%) translateY(20px);background:#1e293b;color:#fff;padding:.9rem 1.4rem;border-radius:12px;font-size:.82rem;font-weight:600;line-height:1.5;text-align:center;max-width:calc(100vw - 2.4rem);box-shadow:0 8px 30px rgba(0,0,0,.3);z-index:9999;opacity:0;transition:opacity .25s,transform .25s;pointer-events:none;border-left:4px solid #f59e0b}
.price-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}

/* ── TRUST STRIP ── */
.trust-strip{display:grid;grid-template-columns:repeat(4,1fr);gap:.6rem;max-width:var(--max);margin:0 auto;padding:2rem 1.2rem}
.trust-item{background:#fff;border:1px solid var(--border);border-radius:var(--radius);padding:1.1rem .8rem;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.04)}
.trust-num{font-size:1.3rem;font-weight:900;color:var(--orange);letter-spacing:-.3px}
.trust-lbl{font-size:.62rem;color:var(--muted);font-weight:600;line-height:1.3;margin-top:.25rem;text-transform:uppercase;letter-spacing:.3px}
.avail-now{text-align:center;padding:0 1.2rem 2rem;max-width:var(--max);margin:0 auto}
.avail-now-badge{display:inline-flex;align-items:center;gap:.5rem;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:.6rem;padding:.7rem 1.3rem;font-size:.85rem;font-weight:700;color:#15803d}
@media(max-width:480px){.trust-strip{grid-template-columns:repeat(2,1fr)}}

/* ── SERVIZI ── */
.section{padding:2rem 1.2rem 2.5rem;max-width:var(--max);margin:0 auto}
.sec-label{display:inline-block;font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:var(--red);background:#fef2f2;border:1px solid #fecaca;padding:.3rem .8rem;border-radius:2rem;margin-bottom:.8rem}
.sec-title{font-size:clamp(1.4rem,4vw,1.8rem);font-weight:800;letter-spacing:-.5px;margin-bottom:.5rem;color:var(--navy)}
.sec-sub{font-size:.88rem;color:var(--muted);line-height:1.6;margin-bottom:1.6rem}
.serv-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:.75rem;margin-bottom:0}
.serv-card{background:#fff;border:1.5px solid var(--border);border-radius:var(--radius);padding:0;transition:border-color .15s,transform .15s,box-shadow .15s;position:relative;overflow:hidden;display:flex;flex-direction:column}
.serv-card::before{content:"";position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,var(--red),var(--orange));opacity:0;transition:opacity .15s;z-index:1}
.serv-card:hover{border-color:#fca5a5;transform:translateY(-3px);box-shadow:0 8px 24px rgba(220,38,38,.1)}
.serv-card:hover::before{opacity:1}
.serv-card .s-img{width:100%;height:130px;object-fit:cover;display:block;flex-shrink:0}
.serv-card .s-name{font-size:.88rem;font-weight:700;color:var(--navy);display:block;margin:.6rem 1rem .15rem}
.serv-card .s-desc{font-size:.72rem;color:var(--muted);line-height:1.4;margin:0 1rem}
.serv-card .s-cta{display:inline-block;margin:.5rem 1rem .8rem;font-size:.7rem;font-weight:700;color:var(--red);text-decoration:none}

/* ── TESTIMONIALS ── */
.dark-section-bg{background:#b08050;border-top:1px solid rgba(0,0,0,.1);border-bottom:1px solid rgba(0,0,0,.1)}
.reviews-section{background:#b08050;border-top:1px solid rgba(0,0,0,.1);border-bottom:1px solid rgba(0,0,0,.1);padding:2.5rem 1.2rem}
.reviews-inner{max-width:var(--max);margin:0 auto}
.reviews-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:.8rem;margin-top:1.5rem}
.review-card{background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:1.2rem}
.review-stars{color:#f59e0b;font-size:.88rem;margin-bottom:.5rem;letter-spacing:.3px}
.review-text{font-size:.8rem;color:var(--muted);line-height:1.55;font-style:italic;margin-bottom:.6rem}
.review-author{font-size:.7rem;font-weight:700;color:var(--navy2)}
@media(max-width:520px){.reviews-grid{grid-template-columns:1fr}}

/* ── COME FUNZIONA ── */
.how-section{background:var(--navy);padding:3rem 1.2rem;color:#fff}
.how-inner{max-width:var(--max);margin:0 auto}
.how-section .sec-label{color:#fbbf24;background:rgba(251,191,36,.1);border-color:rgba(251,191,36,.25)}
.how-section .sec-title{color:#fff}
.how-section .sec-sub{color:rgba(255,255,255,.6)}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;position:relative;margin-top:1.5rem}
.steps::before{content:"";position:absolute;top:22px;left:calc(16.67% + 10px);right:calc(16.67% + 10px);height:1px;background:linear-gradient(90deg,var(--red),var(--orange));z-index:0}
.step{text-align:center;position:relative;z-index:1}
.step-n{width:44px;height:44px;background:linear-gradient(135deg,var(--red),var(--red2));border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1rem;font-weight:900;margin:0 auto .9rem;border:3px solid var(--navy)}
.step h4{font-size:.82rem;font-weight:700;margin-bottom:.25rem;color:#fff}
.step p{font-size:.7rem;color:rgba(255,255,255,.55);line-height:1.4}
@media(max-width:480px){
  .steps{grid-template-columns:1fr;gap:1.2rem}
  .steps::before{display:none}
  .step{display:flex;align-items:center;gap:1rem;text-align:left}
  .step-n{margin:0;flex-shrink:0;width:38px;height:38px;font-size:.9rem}
}

/* ── FORM ── */
.form-section{padding:2.5rem 1.2rem;max-width:580px;margin:0 auto}
.form-card{background:#fff;border-radius:20px;padding:2rem 1.8rem;box-shadow:0 8px 40px rgba(0,0,0,.08);border:1px solid var(--border)}
.form-card h2{font-size:1.3rem;font-weight:800;letter-spacing:-.4px;margin-bottom:.25rem;color:var(--navy)}
.form-card .sub{font-size:.83rem;color:var(--muted);margin-bottom:1.5rem;line-height:1.5}
.field{margin-bottom:1rem}
.field label{display:block;font-size:.68rem;font-weight:700;color:var(--muted);margin-bottom:.35rem;text-transform:uppercase;letter-spacing:.5px}
input[type=text],input[type=tel],select{width:100%;padding:.78rem 1rem;border:1.5px solid var(--border);border-radius:10px;font-size:.93rem;color:var(--text);background:#f8fafc;transition:border-color .2s,background .2s;font-family:inherit;appearance:none}
input:focus,select:focus{outline:none;border-color:var(--red);background:#fff;box-shadow:0 0 0 3px rgba(220,38,38,.08)}
select{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%2364748b' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 1rem center;background-color:#f8fafc;padding-right:2.5rem}
.row{display:grid;grid-template-columns:1fr 1fr;gap:.7rem}
.geo-btn{width:100%;padding:.72rem 1rem;background:var(--navy);color:#fff;border:none;border-radius:10px;font-size:.85rem;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:.45rem;margin-bottom:.5rem;transition:background .15s;font-family:inherit}
.geo-btn:hover{background:var(--navy2)}.geo-btn:disabled{opacity:.6;cursor:wait}
.geo-status{font-size:.73rem;text-align:center;margin-bottom:.75rem;min-height:1em;color:var(--muted)}
.geo-status.ok{color:var(--green);font-weight:600}.geo-status.err{color:var(--red);font-weight:600}
.fasce{display:grid;grid-template-columns:repeat(3,1fr);gap:.45rem;margin-top:.35rem}
.fascia-opt{cursor:pointer}
.fascia-opt input{display:none}
.fascia-opt span{display:block;padding:.7rem .3rem;text-align:center;border:1.5px solid var(--border);border-radius:10px;background:#f8fafc;font-size:.72rem;font-weight:700;color:var(--muted);transition:all .15s;line-height:1.3}
.fascia-opt input:checked+span{border-color:var(--red);background:#fef2f2;color:var(--red)}
.fascia-opt span small{display:block;font-size:.65rem;font-weight:500;margin-top:.12rem;opacity:.8}
.prezzo-box{background:linear-gradient(135deg,var(--navy),var(--navy2));color:#fff;border-radius:12px;padding:1rem 1.2rem;margin:1rem 0;display:flex;align-items:center;justify-content:space-between;gap:1rem}
.prezzo-box .lbl{font-size:.68rem;text-transform:uppercase;letter-spacing:.4px;opacity:.65;margin-bottom:.1rem}
.prezzo-box .sub{font-size:.63rem;opacity:.5;margin-top:.1rem}
.prezzo-box .val{font-size:1.8rem;font-weight:900;letter-spacing:-.5px;color:var(--orange);white-space:nowrap}
.condizioni-box{background:#fffbeb;border:1.5px solid #fbbf24;border-radius:10px;margin-bottom:1rem;overflow:hidden}
.condizioni-toggle{width:100%;background:none;border:none;padding:.8rem 1rem;display:flex;align-items:center;justify-content:space-between;font-size:.8rem;font-weight:700;color:#92400e;cursor:pointer;text-align:left;font-family:inherit}
.condizioni-toggle .arrow{font-size:.65rem;transition:transform .2s;opacity:.7}
.condizioni-toggle.open .arrow{transform:rotate(180deg)}
.condizioni-lista{display:none;padding:0 1rem .9rem;border-top:1px solid #fde68a}
.condizioni-lista.open{display:block}
.condizioni-lista ol{padding-left:1.1rem;margin-top:.55rem}
.condizioni-lista li{font-size:.75rem;color:#78350f;line-height:1.6;margin-bottom:.35rem}
.condizioni-lista li strong{color:#92400e}
.condizioni-nota{margin-top:.5rem;font-size:.7rem;color:#b45309;font-style:italic;padding-top:.45rem;border-top:1px dashed #fcd34d}
/* TOS — accettazione obbligatoria pre-pagamento */
.tos-row{display:flex;align-items:flex-start;gap:.55rem;max-width:520px;margin:.6rem auto .5rem;padding:.7rem .85rem;background:rgba(255,255,255,.08);border:1.5px solid rgba(255,255,255,.22);border-radius:10px;cursor:pointer;position:relative;z-index:1;transition:border-color .2s,background .2s}
.tos-row.tos-row-light{background:rgba(0,0,0,.04);border-color:#cbd5e1}
.tos-row.tos-error{border-color:#dc2626;background:rgba(220,38,38,.18);animation:tosShake .35s}
@keyframes tosShake{0%,100%{transform:translateX(0)}25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}
.tos-row input[type=checkbox]{width:18px;height:18px;min-width:18px;margin-top:2px;cursor:pointer;accent-color:#f59e0b}
.tos-row label{font-size:.78rem;color:rgba(255,255,255,.92);font-weight:600;cursor:pointer;line-height:1.45;flex:1}
.tos-row.tos-row-light label{color:#334155}
.tos-row a.tos-link{color:#fde68a;text-decoration:underline;font-weight:700}
.tos-row.tos-row-light a.tos-link{color:#0ea5e9}
.tos-error-msg{display:none;max-width:520px;margin:-.2rem auto .55rem;padding:.55rem .8rem;background:#dc2626;color:#fff;border-radius:8px;font-size:.78rem;font-weight:700;text-align:center;position:relative;z-index:1}
.tos-error-msg.show{display:block}
.cta-disabled{opacity:.55!important;cursor:not-allowed!important;filter:grayscale(.4);pointer-events:auto!important}
.cta-disabled:hover{transform:none!important;box-shadow:0 8px 26px rgba(245,158,11,.42)!important}
/* Modal */
.tos-modal-overlay{display:none;position:fixed;inset:0;background:rgba(15,23,42,.78);z-index:9999;align-items:flex-start;justify-content:center;padding:2rem 1rem;overflow-y:auto;animation:tosFade .15s}
.tos-modal-overlay.show{display:flex}
@keyframes tosFade{from{opacity:0}to{opacity:1}}
.tos-modal{background:#fff;color:#1e293b;max-width:680px;width:100%;border-radius:14px;padding:1.5rem 1.6rem;box-shadow:0 25px 60px rgba(0,0,0,.4);position:relative;max-height:88vh;overflow-y:auto}
.tos-modal h2{margin:0 0 .3rem;font-size:1.35rem;color:#0f172a}
.tos-modal .ver{color:#64748b;font-size:.8rem;margin-bottom:1.1rem;padding-bottom:.7rem;border-bottom:1px solid #e2e8f0}
.tos-modal h3{font-size:1rem;color:#1e40af;margin:1.2rem 0 .35rem}
.tos-modal p,.tos-modal li{font-size:.86rem;line-height:1.6;color:#334155}
.tos-modal ul{padding-left:1.3rem}
.tos-modal-close{position:sticky;top:0;float:right;background:#f1f5f9;border:none;width:34px;height:34px;border-radius:50%;font-size:1.3rem;cursor:pointer;color:#475569;font-weight:700;line-height:1}
.tos-modal-close:hover{background:#e2e8f0;color:#0f172a}
.tos-modal-actions{display:flex;gap:.6rem;margin-top:1.5rem;padding-top:1rem;border-top:1px solid #e2e8f0;flex-wrap:wrap}
.tos-modal-actions button{flex:1;min-width:140px;padding:.75rem 1rem;border-radius:8px;border:none;cursor:pointer;font-weight:700;font-size:.9rem}
.tos-modal-actions .tos-accept{background:#16a34a;color:#fff}
.tos-modal-actions .tos-accept:hover{background:#15803d}
.tos-modal-actions .tos-cancel{background:#e2e8f0;color:#334155}
.tos-modal-actions .tos-cancel:hover{background:#cbd5e1}
.accetta-row{display:flex;align-items:flex-start;gap:.6rem;margin-bottom:.9rem;padding:.8rem;background:#f8fafc;border:1.5px solid var(--border);border-radius:10px;cursor:pointer}
.accetta-row input[type=checkbox]{width:18px;height:18px;min-width:18px;margin-top:2px;cursor:pointer;accent-color:var(--red)}
.accetta-row label{font-size:.77rem;color:var(--muted);font-weight:500;cursor:pointer;line-height:1.5}
.accetta-row label strong{color:var(--red)}
.fattura-toggle-row{display:flex;align-items:center;gap:.6rem;margin:.6rem 0 0;padding:.7rem .9rem;background:#f0f4ff;border:1.5px solid #c7d2fe;border-radius:10px;cursor:pointer}
.fattura-toggle-row input[type=checkbox]{width:17px;height:17px;min-width:17px;cursor:pointer;accent-color:#4f46e5}
#fattura-fields{background:#f8f9ff;border:1.5px dashed #c7d2fe;border-radius:10px;padding:1rem;margin-top:.5rem;margin-bottom:.2rem}
.fattura-note{font-size:.75rem;color:#6366f1;margin-top:.5rem;padding:.4rem .6rem;background:#eef2ff;border-radius:.35rem}
.trust-row{display:flex;justify-content:center;gap:.8rem;flex-wrap:wrap;padding:.75rem;background:#f0fdf4;border-radius:10px;margin-bottom:.9rem}
.trust-row span{font-size:.7rem;font-weight:700;color:#166534;display:flex;align-items:center;gap:.25rem}
.submit-btn{width:100%;padding:1rem;background:linear-gradient(135deg,var(--red),var(--red2));color:#fff;border:none;border-radius:12px;font-size:1.05rem;font-weight:800;cursor:pointer;font-family:inherit;transition:opacity .15s,transform .1s;text-transform:uppercase;letter-spacing:.3px;box-shadow:0 6px 20px rgba(220,38,38,.35)}
.submit-btn:hover{opacity:.92;transform:translateY(-1px)}.submit-btn:active{transform:scale(.98)}.submit-btn:disabled{opacity:.5;cursor:not-allowed;transform:none}
#messaggio{display:none;margin-top:.9rem;padding:1rem;border-radius:10px;background:#f0fdf4;border:1.5px solid #86efac;color:#166534;font-weight:700;text-align:center;font-size:.88rem}
@media(max-width:480px){.row{grid-template-columns:1fr}.fasce{grid-template-columns:1fr}}

/* ── FOOTER ── */
footer{background:var(--navy);border-top:1px solid rgba(255,255,255,.08);color:rgba(255,255,255,.45);text-align:center;padding:2.5rem 1.2rem;font-size:.75rem;line-height:2}
footer a{color:rgba(255,255,255,.65);text-decoration:none}
footer a:hover{color:#fff}
footer strong{color:#fff}

/* ── STICKY BOTTOM BAR (mobile) ── */
.sticky-bar{display:none;position:fixed;bottom:0;left:0;right:0;z-index:300;background:rgba(255,255,255,.98);border-top:2px solid var(--border);backdrop-filter:blur(20px);padding:.75rem 1rem calc(.75rem + env(safe-area-inset-bottom));gap:.7rem;box-shadow:0 -6px 24px rgba(0,0,0,.12)}
.sticky-bar a{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.15rem;padding:1rem .5rem;border-radius:12px;text-decoration:none;text-align:center}
.sticky-bar a strong{font-size:.92rem;font-weight:900;letter-spacing:.1px}
.sticky-bar a span{font-size:.68rem;font-weight:600;opacity:.85}
.sticky-green{background:var(--green);color:#fff;box-shadow:0 5px 16px rgba(22,163,74,.35)}
.sticky-pay{background:linear-gradient(135deg,#f59e0b,#d97706);color:#fff!important;box-shadow:0 5px 16px rgba(245,158,11,.45);animation:pulseOrange 1.2s ease-in-out infinite;position:relative;transform-origin:center;transition:background .2s,transform .15s}
.sticky-pay:hover{background:linear-gradient(135deg,#d97706,#b45309)!important;transform:scale(1.07);animation:none}
@keyframes pulseOrange{0%{transform:scale(1);box-shadow:0 0 0 0 rgba(255,140,0,.6)}70%{transform:scale(1.05);box-shadow:0 0 0 12px rgba(255,140,0,0)}100%{transform:scale(1);box-shadow:0 0 0 0 rgba(255,140,0,0)}}
.sticky-scarcity{text-align:center;font-size:.65rem;color:#92400e;font-weight:700;letter-spacing:.2px;padding:.25rem 0 .1rem;background:rgba(245,158,11,.12)}
@media(max-width:680px){.sticky-bar{display:flex}}

/* ── DESCRIPTION TEXTAREA ── */
textarea#descrizione{width:100%;padding:.78rem 1rem;border:1.5px solid var(--border);border-radius:10px;font-size:.93rem;color:var(--text);background:#f8fafc;transition:border-color .2s,background .2s;font-family:inherit;resize:vertical;min-height:80px}
textarea#descrizione:focus{outline:none;border-color:var(--red);background:#fff;box-shadow:0 0 0 3px rgba(220,38,38,.08)}

/* ── AUDIO RECORDER ── */
.audio-section{margin:1rem 0}
.audio-lbl{display:block;font-size:.68rem;font-weight:700;color:var(--muted);margin-bottom:.5rem;text-transform:uppercase;letter-spacing:.5px}
.audio-btn-row{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
.btn-audio{display:inline-flex;align-items:center;gap:.4rem;padding:.7rem 1.1rem;border:1.5px solid var(--border);border-radius:10px;background:#f8fafc;color:var(--navy);font-size:.85rem;font-weight:600;cursor:pointer;font-family:inherit;transition:all .15s}
.btn-audio:hover{border-color:#93c5fd;background:#eff6ff}
.btn-audio.recording{background:#fee2e2;border-color:var(--red);color:var(--red);animation:pulse-red 1.2s infinite}
@keyframes pulse-red{0%,100%{box-shadow:0 0 0 0 rgba(220,38,38,.3)}50%{box-shadow:0 0 0 6px rgba(220,38,38,0)}}
.btn-audio:disabled{opacity:.5;cursor:not-allowed}
.audio-timer{font-size:.95rem;font-weight:800;color:var(--red);min-width:3rem;font-variant-numeric:tabular-nums}
.audio-preview{margin-top:.7rem;display:none;align-items:center;gap:.6rem}
.audio-preview audio{flex:1;height:36px}
.audio-clear{font-size:.75rem;color:var(--muted);cursor:pointer;text-decoration:underline;background:none;border:none;font-family:inherit;white-space:nowrap;flex-shrink:0}

/* ── FOTO UPLOAD ── */
.foto-section{margin:1rem 0}
.foto-lbl{display:block;font-size:.68rem;font-weight:700;color:var(--muted);margin-bottom:.5rem;text-transform:uppercase;letter-spacing:.5px}
.foto-btn{display:inline-flex;align-items:center;justify-content:center;gap:.4rem;padding:.7rem 1.1rem;border:1.5px solid var(--border);border-radius:10px;background:#f8fafc;color:var(--navy);font-size:.85rem;font-weight:600;cursor:pointer;font-family:inherit;transition:all .15s;width:100%}
.foto-btn:hover{border-color:#93c5fd;background:#eff6ff}
.foto-previews{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.6rem}
.foto-thumb-wrap{position:relative}
.foto-thumb{width:72px;height:72px;object-fit:cover;border-radius:8px;border:2px solid var(--border)}
.foto-remove{position:absolute;top:-6px;right:-6px;width:20px;height:20px;background:var(--red);color:#fff;border-radius:50%;font-size:.65rem;display:flex;align-items:center;justify-content:center;cursor:pointer;border:none;font-family:inherit;line-height:1}

/* ── PAYMENT SECTION (post-success) ── */
.pay-section{display:none;margin-top:1.2rem;border-radius:16px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.15)}
.pay-section.show{display:block;animation:fadeSlide .35s ease}
@keyframes fadeSlide{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
.pay-header{background:linear-gradient(135deg,#065f46,#047857);padding:1.6rem 1.5rem 1.2rem;text-align:center;color:#fff}
.pay-check{font-size:2.4rem;line-height:1;margin-bottom:.6rem}
.pay-title{font-size:1.5rem;font-weight:900;letter-spacing:-.4px;margin-bottom:.5rem}
.pay-desc{font-size:.87rem;opacity:.88;line-height:1.6;margin:0 auto;max-width:280px}
.pay-urgency{display:inline-flex;align-items:center;gap:.35rem;background:rgba(255,255,255,.15);border-radius:.5rem;padding:.45rem .9rem;font-size:.8rem;font-weight:800;margin-top:.8rem;border:1px solid rgba(255,255,255,.2)}
.pay-body{background:#fff;padding:1.4rem 1.5rem;text-align:center}
.pay-lock-note{display:inline-flex;align-items:center;gap:.4rem;background:#fff8e1;border:1.5px solid #fbbf24;border-radius:.5rem;padding:.5rem 1rem;font-size:.8rem;font-weight:700;color:#92400e;margin-bottom:1rem;width:100%;justify-content:center}
.pay-btn{display:flex;align-items:center;justify-content:center;gap:.6rem;width:100%;background:linear-gradient(135deg,#f59e0b,#d97706);color:#fff;text-decoration:none;padding:1.2rem 1.5rem;border-radius:12px;font-size:1.15rem;font-weight:900;letter-spacing:.3px;box-shadow:0 8px 28px rgba(245,158,11,.5);transition:transform .15s,box-shadow .15s;text-transform:uppercase;border:none;cursor:pointer;font-family:inherit}
.pay-btn:active{transform:scale(.97)}
@media(hover:hover){.pay-btn:hover{transform:translateY(-2px);box-shadow:0 12px 36px rgba(245,158,11,.65)}}
.pay-safe{display:flex;justify-content:center;gap:.8rem;margin-top:.9rem;flex-wrap:wrap}
.pay-safe span{font-size:.7rem;color:var(--muted);display:flex;align-items:center;gap:.25rem}
.pay-call{display:flex;align-items:center;justify-content:center;gap:.4rem;margin-top:.9rem;padding:.65rem 1rem;border:1.5px solid #e5e7eb;border-radius:10px;font-size:.82rem;font-weight:700;color:var(--navy);text-decoration:none;background:#f8fafc;transition:background .15s}
.pay-call:hover{background:#e8f0fb}
.pay-skip{display:block;margin-top:.7rem;font-size:.72rem;color:var(--muted);cursor:pointer;text-decoration:underline;background:none;border:none;font-family:inherit;width:100%;text-align:center;padding:.3rem}
</style>
</head>
<body>

<!-- NAV -->
<nav>
  <a class="nav-logo" href="/">
    <img class="nav-logo-img" src="/pim-logo.png" alt="PIM Logo"/>
    <div class="nav-text">
      <span class="nav-name">www.prontointerventomi.it</span>
      <span class="nav-elettro">by ELETTROTECH</span>
    </div>
  </a>
  <div class="nav-spacer"></div>
  <a class="nav-tel" href="tel:+393405707813"><svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.72 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.63 1.5h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 9.1a16 16 0 0 0 6 6l.96-.96a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 21.5 16.5l.42.42z"/></svg> 340 570 7813</a>
  <a class="btn-red" href="#form"><span class="lbl-full">Richiedi intervento</span><span class="lbl-mob">Prenota</span></a>
  <a class="btn-green" href="tel:+393405707813"><svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.72 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.63 1.5h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 9.1a16 16 0 0 0 6 6l.96-.96a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 21.5 16.5l.42.42z"/></svg><span class="lbl-full" style="margin-left:.35rem">Chiama ora</span><span class="lbl-mob" style="margin-left:.3rem">Chiama</span></a>
</nav>

<!-- BANNER FUORI SERVIZIO (nascosto di default, mostrato via JS) -->
<div id="avail-offline-banner" style="display:none;position:sticky;top:0;z-index:9000;background:#7f1d1d;color:#fecaca;padding:1rem 1.5rem;text-align:center;font-weight:700;font-size:1rem;font-family:inherit;border-bottom:2px solid #ef4444">
  ⚠️ Al momento non ci sono tecnici disponibili. Riprova più tardi o contattaci telefonicamente.
</div>

<!-- HERO -->
<section class="hero">
  <div class="hero-inner">
    <div class="hero-logo-wrap">
      <img src="/pim-logo.png" alt="Pronto Intervento Milano — Logo"/>
    </div>
    <div class="avail-tag"><span class="avail-dot"></span> Tecnico disponibile subito a Milano</div>
    <h1>Elettricista urgente<br>a Milano in <span class="hl">90 minuti</span></h1>
    <p class="hero-sub"><strong>Operativi H24</strong> · Milano e provincia · Prezzo fisso senza sorprese</p>

    <!-- NOTA PRE-AUTORIZZAZIONE -->
    <div style="background:rgba(255,255,255,.13);border:1px solid rgba(255,255,255,.28);border-radius:.6rem;padding:.7rem 1rem;font-size:.8rem;color:rgba(255,255,255,.95);max-width:420px;margin:0 auto 1rem;line-height:1.55;backdrop-filter:blur(6px);position:relative;z-index:1;text-align:center">
      🔒 <strong>Blocchi il tecnico ora. Nessun addebito immediato.</strong><br><span style="opacity:.85">Importo solo autorizzato sulla carta</span>
    </div>

    <!-- ETICHETTA ORARIO DISPONIBILITÀ -->
    <div id="price-avail-label" class="price-avail-label day">🟢 Orario feriale — Disponibili: Standard e Urgente</div>

    <!-- PRICE CARDS -->
    <div class="price-cards">
      <div class="price-card" id="card-standard" data-fascia="standard">
        <div class="price-check">✓</div>
        <div class="price-card-name">Standard</div>
        <div class="price-card-time">Entro 4 ore</div>
        <div class="price-card-amt">€70</div>
      </div>
      <div class="price-card rec" id="card-urgente" data-fascia="urgente">
        <div class="price-check">✓</div>
        <div class="rec-badge">★ Consigliato</div>
        <div class="price-card-name">Urgente</div>
        <div class="price-card-time">Entro 60–90 min</div>
        <div class="price-card-amt">€120</div>
      </div>
      <div class="price-card" id="card-notte" data-fascia="notte_festivo">
        <div class="price-check">✓</div>
        <div class="price-card-name">Serale / Festivi</div>
        <div class="price-card-time">Intervento prioritario</div>
        <div class="price-card-amt">€200</div>
      </div>
    </div>

    <!-- URGENZA SOPRA BOTTONI -->
    <p style="text-align:center;font-size:.82rem;font-weight:800;color:#fde68a;letter-spacing:.3px;margin:0 0 .6rem;position:relative;z-index:1">📍 Tecnico disponibile subito in zona</p>

    <!-- TOS — accettazione obbligatoria -->
    <div class="tos-row" data-tos-row="hero">
      <input type="checkbox" id="tos-hero" data-tos-checkbox aria-required="true">
      <label for="tos-hero">Ho letto e accetto i <a href="/termini-servizio" class="tos-link" data-tos-open target="_blank" rel="noopener">Termini di Servizio</a></label>
    </div>
    <div class="tos-error-msg" data-tos-error="hero">⚠️ Devi accettare i Termini di Servizio per procedere.</div>

    <!-- CTA BOTTONE UNICO DINAMICO -->
    <a id="hero-pay-cta" class="hero-pay-cta cta-disabled" data-tos-cta="hero" href="/api/paga?fascia=urgente" target="_blank" rel="noopener noreferrer">
      <span id="hero-pay-icon">🔒</span> <span id="hero-pay-label">BLOCCA TECNICO ORA</span> — <span id="hero-pay-price">€120</span>
    </a>

    <!-- SCARSITÀ DINAMICA -->
    <div id="scarcity-box" style="text-align:center;margin:.4rem 0 .2rem;position:relative;z-index:1">
      <p id="scarcity-main" style="font-size:.8rem;font-weight:800;color:#fca5a5;margin:0 0 .15rem;letter-spacing:.2px">⚡ 1 tecnico disponibile in zona</p>
      <p id="scarcity-sub" style="font-size:.68rem;color:rgba(255,255,255,.7);margin:0">A causa dell'elevata richiesta, la disponibilità è limitata</p>
    </div>

    <!-- CHIAREZZA PREZZI + PRE-AUTH -->
    <div style="background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.18);border-radius:.6rem;padding:.8rem 1rem;max-width:420px;margin:.7rem auto .3rem;position:relative;z-index:1">
      <p style="text-align:center;font-size:.75rem;color:rgba(255,255,255,.95);margin:0 0 .4rem;line-height:1.6">
        L'importo copre <strong>esclusivamente</strong> l'uscita del tecnico e la diagnosi del guasto.<br>
        Eventuali riparazioni, materiali o lavorazioni aggiuntive saranno sempre <strong>preventivate e concordate prima</strong> dell'esecuzione.
      </p>
      <p style="text-align:center;font-size:.72rem;color:#fde68a;margin:0 0 .35rem;font-weight:700">
        Uscita e diagnosi incluse. Nessun lavoro extra senza approvazione.
      </p>
      <p style="text-align:center;font-size:.7rem;color:rgba(255,255,255,.8);margin:0;line-height:1.5">
        🔒 L'importo viene solo <strong>pre-autorizzato</strong> sulla carta. Nessun addebito immediato.
        <span title="La tariffa indicata non comprende interventi di riparazione o fornitura materiali." style="cursor:help;display:inline-block;width:15px;height:15px;background:rgba(255,255,255,.25);border-radius:50%;text-align:center;line-height:15px;font-size:.6rem;font-weight:900;vertical-align:middle;margin-left:3px">ℹ</span>
      </p>
    </div>

    <!-- MICRO COPY FIDUCIA -->
    <p style="text-align:center;font-size:.68rem;color:rgba(255,255,255,.7);position:relative;z-index:1;margin:.25rem 0 .8rem;letter-spacing:.2px">
      Intervento rapido &nbsp;•&nbsp; Senza sorprese &nbsp;•&nbsp; Preventivo prima dei lavori
    </p>

    <div class="hero-trust">
      <span>✅ Disponibile subito</span>
      <span>⚡ Arrivo entro 60–90 minuti</span>
      <span>🔒 Pagamento sicuro</span>
    </div>
  </div>
</section>

<!-- BLOCCO LOCALI / PRIORITARIO -->
<section style="background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%);padding:2rem 1rem 2.2rem;position:relative;overflow:hidden">
  <div style="max-width:520px;margin:0 auto;position:relative;z-index:1">
    <!-- Bordo decorativo in alto -->
    <div style="width:48px;height:3px;background:#f97316;border-radius:2px;margin:0 auto 1.1rem"></div>
    <p style="text-align:center;font-size:.72rem;font-weight:900;letter-spacing:1.2px;color:#94a3b8;text-transform:uppercase;margin:0 0 .5rem">Per locali commerciali</p>
    <h2 style="text-align:center;font-size:1.35rem;font-weight:900;color:#fff;line-height:1.3;margin:0 0 .9rem">
      Se non puoi permetterti<br>90 minuti di fermo
    </h2>
    <p style="text-align:center;font-size:.88rem;font-style:italic;color:#94a3b8;margin:0 0 1.1rem">Intervento prioritario per locali aperti al pubblico</p>

    <!-- CHECK LIST -->
    <div style="display:flex;flex-direction:column;gap:.45rem;margin:0 0 1.3rem">
      <div style="display:flex;align-items:center;gap:.6rem;font-size:.82rem;color:#e2e8f0">
        <span style="color:#4ade80;font-size:1rem;flex-shrink:0">✔</span>
        <span>Ripristino immediato guidato tramite assistenza AI</span>
      </div>
      <div style="display:flex;align-items:center;gap:.6rem;font-size:.82rem;color:#e2e8f0">
        <span style="color:#4ade80;font-size:1rem;flex-shrink:0">✔</span>
        <span>Tecnico in arrivo entro 90 minuti</span>
      </div>
      <div style="display:flex;align-items:center;gap:.6rem;font-size:.82rem;color:#e2e8f0">
        <span style="color:#4ade80;font-size:1rem;flex-shrink:0">✔</span>
        <span>Servizio dedicato a bar, ristoranti e locali notturni</span>
      </div>
    </div>

    <!-- TOS — accettazione obbligatoria (locali) -->
    <div class="tos-row" data-tos-row="locali" style="background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.22);margin-top:.5rem">
      <input type="checkbox" id="tos-locali" data-tos-checkbox aria-required="true">
      <label for="tos-locali">Ho letto e accetto i <a href="/termini-servizio" class="tos-link" data-tos-open target="_blank" rel="noopener">Termini di Servizio</a></label>
    </div>
    <div class="tos-error-msg" data-tos-error="locali">⚠️ Devi accettare i Termini di Servizio per procedere.</div>

    <!-- BOTTONE PRIORITARIO -->
    <a href="/api/paga?fascia=prioritario" target="_blank" rel="noopener noreferrer" data-tos-cta="locali" class="cta-disabled"
       style="display:block;width:100%;box-sizing:border-box;background:linear-gradient(135deg,#f97316,#ea580c);color:#fff;font-size:1rem;font-weight:900;letter-spacing:.5px;text-align:center;text-decoration:none;padding:.95rem 1rem;border-radius:.7rem;border:none;cursor:pointer;box-shadow:0 4px 20px rgba(249,115,22,.4);transition:transform .15s">
      INTERVENTO PRIORITARIO – €350
    </a>

    <!-- DISCLAIMER SOTTO IL BOTTONE -->
    <div style="background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:.55rem;padding:.75rem .9rem;margin-top:.9rem">
      <p style="font-size:.68rem;color:#94a3b8;margin:0 0 .35rem;line-height:1.65">
        L'importo di €350 copre l'uscita tecnica prioritaria e la diagnosi del guasto.
      </p>
      <p style="font-size:.68rem;color:#94a3b8;margin:0 0 .35rem;line-height:1.65">
        L'<strong style="color:#cbd5e1">assistenza AI è inclusa</strong> ed è disponibile subito dopo la richiesta per tentare un ripristino parziale dell'impianto in sicurezza mentre il tecnico è in arrivo.
      </p>
      <p style="font-size:.68rem;color:#94a3b8;margin:0 0 .35rem;line-height:1.65">
        L'uscita tecnica resta dovuta anche in caso di ripristino parziale tramite assistenza AI.
      </p>
      <p style="font-size:.68rem;color:#94a3b8;margin:0 0 .35rem;line-height:1.65">
        Riparazioni, materiali e lavorazioni aggiuntive sono sempre preventivati prima.
      </p>
      <p style="font-size:.7rem;color:#fde68a;font-weight:700;margin:0;line-height:1.5">
        🔒 Nessun addebito immediato: importo solo pre-autorizzato sulla carta.
      </p>
    </div>
  </div>
</section>

<!-- TRUST STRIP -->
<div class="trust-strip">
  <div class="trust-item"><div class="trust-num">60–90</div><div class="trust-lbl">Minuti arrivo medio</div></div>
  <div class="trust-item"><div class="trust-num">5 min</div><div class="trust-lbl">Risposta garantita</div></div>
  <div class="trust-item"><div class="trust-num">H24</div><div class="trust-lbl">Operativi H24</div></div>
  <div class="trust-item"><div class="trust-num">100%</div><div class="trust-lbl">Servizio garantito</div></div>
</div>
<div class="avail-now"><div class="avail-now-badge">✅ Disponibile ORA a Milano — Risposta entro 5 minuti</div></div>

<!-- SERVIZI -->
<div class="dark-section-bg">
<section class="section">
  <div class="sec-label">I nostri servizi</div>
  <h2 class="sec-title">Interveniamo su</h2>
  <p class="sec-sub">Intervento rapido a Milano e provincia. Disponibile subito per ogni tipo di guasto elettrico.</p>
  <div class="serv-grid">
    <div class="serv-card"><img class="s-img" src="/serv-elettricista.png" alt="Elettricista"/><span class="s-name">Elettricista</span><span class="s-desc">Guasti, interruttori, prese, quadri elettrici, cortocircuiti.</span><a class="s-cta" href="#form">Richiedi →</a></div>
    <div class="serv-card"><img class="s-img" src="/serv-citofono.png" alt="Citofoni"/><span class="s-name">Citofoni</span><span class="s-desc">Installazione, sostituzione e riparazione citofoni e videocitofoni.</span><a class="s-cta" href="#form">Richiedi →</a></div>
    <div class="serv-card"><img class="s-img" src="/serv-antenna.png" alt="Antenne TV"/><span class="s-name">Antenne TV</span><span class="s-desc">Installazione, orientamento e riparazione antenne digitali e satellitari.</span><a class="s-cta" href="#form">Richiedi →</a></div>
    <div class="serv-card"><img class="s-img" src="/serv-allarme.png" alt="Allarmi"/><span class="s-name">Allarmi</span><span class="s-desc">Sistemi antifurto, sensori, sirene, manutenzione e riparazione.</span><a class="s-cta" href="#form">Richiedi →</a></div>
    <div class="serv-card"><img class="s-img" src="/serv-cancello.png" alt="Automazione cancelli"/><span class="s-name">Automazione cancelli</span><span class="s-desc">Cancelli elettrici, motori, telecomandi e sistemi di accesso.</span><a class="s-cta" href="#form">Richiedi →</a></div>
  </div>
</section>
</div>

<!-- RECENSIONI -->
<section class="reviews-section">
  <div class="reviews-inner">
    <div class="sec-label">Recensioni clienti</div>
    <h2 class="sec-title" style="color:var(--navy)">Cosa dicono di noi</h2>
    <div class="reviews-grid">
      <div class="review-card"><div class="review-stars">★★★★★</div><p class="review-text">"Arrivato in meno di un'ora, problema risolto subito. Tecnico molto professionale e prezzo onesto."</p><div class="review-author">Marco T. — Milano Centrale</div></div>
      <div class="review-card"><div class="review-stars">★★★★★</div><p class="review-text">"Tecnico puntuale e prezzo chiaro sin dall'inizio. Finalmente un servizio di cui fidarsi."</p><div class="review-author">Giulia R. — Navigli</div></div>
      <div class="review-card"><div class="review-stars">★★★★★</div><p class="review-text">"Servizio rapido e professionale. Li ho chiamati di domenica sera e sono venuti senza problemi."</p><div class="review-author">Alessandro M. — Città Studi</div></div>
    </div>
  </div>
</section>

<!-- COME FUNZIONA -->
<section class="how-section">
  <div class="how-inner">
    <div class="sec-label">Semplicissimo</div>
    <h2 class="sec-title">Come funziona</h2>
    <p class="sec-sub">Dalla richiesta all'intervento, tutto in pochi passaggi.</p>
    <div class="steps">
      <div class="step"><div class="step-n">1</div><div><h4>Compila la richiesta</h4><p>Indirizzo, tipo di intervento e fascia oraria.</p></div></div>
      <div class="step"><div class="step-n">2</div><div><h4>Assegniamo il tecnico</h4><p>Il più vicino e disponibile nella tua zona.</p></div></div>
      <div class="step"><div class="step-n">3</div><div><h4>Intervento a casa</h4><p>Preventivo sul posto. Decidi tu se procedere.</p></div></div>
    </div>
  </div>
</section>

<!-- FORM -->
<section class="form-section" id="form">
  <div class="condizioni-box">
    <button type="button" class="condizioni-toggle" onclick="toggleCondizioni()">
      <span>⚠️ Condizioni di servizio — leggere prima di procedere</span>
      <span class="arrow">▼</span>
    </button>
    <div class="condizioni-lista" id="condizioni-lista">
      <ol>
        <li><strong>Diritto di chiamata:</strong> Il costo di uscita è dovuto per la sola presa in carico e il trasferimento del tecnico, indipendentemente dall'esito.</li>
        <li><strong>Esclusioni:</strong> Il costo <u>non comprende</u> riparazioni, materiali, ricambi, ricerca guasto complessa, opere murarie.</li>
        <li><strong>Preventivo in loco:</strong> Il preventivo definitivo viene formulato dal tecnico sul posto. Il cliente è libero di accettarlo o rifiutarlo.</li>
        <li><strong>Annullamento tardivo:</strong> Se il cliente è assente o annulla dopo l'avvio del tecnico, il costo di uscita resta acquisito.</li>
        <li><strong>Mancata presentazione:</strong> Se il tecnico non si presenta senza preavviso, il costo viene rimborsato entro 5 giorni lavorativi.</li>
        <li><strong>Ruolo piattaforma:</strong> prontointerventomi.it opera come intermediario tecnologico tra cliente e tecnico.</li>
        <li><strong>Tempi di arrivo:</strong> I tempi indicati sono stimati. Traffico, meteo o ZTL possono causare ritardi.</li>
      </ol>
      <div class="condizioni-nota">Inviando la richiesta, il cliente dichiara di aver letto, compreso e accettato le condizioni. Data e ora vengono registrate.</div>
    </div>
  </div>
  <div class="form-card">
    <h2>Richiedi intervento ora</h2>
    <p class="sub">Compila il modulo — ti confermiamo il tecnico entro 5 minuti.</p>
    <form id="formr">
      <div class="row">
        <div class="field"><label for="nome">Nome e cognome</label><input type="text" id="nome" required placeholder="Mario Rossi"/></div>
        <div class="field"><label for="telefono">Telefono</label><input type="tel" id="telefono" required placeholder="+39 333 1234567"/></div>
        <div class="field"><label for="email">Email <span style="font-weight:400;opacity:.6">(facoltativa — ricevi conferma via email)</span></label><input type="email" id="email" placeholder="mario@esempio.it" autocomplete="email"/></div>
      </div>
      <button type="button" id="geo-btn" class="geo-btn">📍 Usa la mia posizione attuale</button>
      <div id="geo-status" class="geo-status"></div>
      <div class="row">
        <div class="field"><label for="indirizzo">Indirizzo</label><input type="text" id="indirizzo" required placeholder="Via Roma 1, Milano"/></div>
        <div class="field"><label for="cap">CAP</label><input type="text" id="cap" required pattern="[0-9]{5}" maxlength="5" placeholder="20121"/></div>
      </div>
      <div class="field">
        <label for="servizio">Tipo di intervento</label>
        <select id="servizio" required>
          <option value="" disabled selected>Seleziona un servizio...</option>
          <option value="impianti_elettrici">Impianti elettrici</option>
          <option value="allarmi">Allarmi</option>
          <option value="automazione_cancelli">Automazione cancelli</option>
          <option value="citofoni">Citofoni</option>
          <option value="antenne">Antenne TV</option>
        </select>
      </div>
      <div class="field">
        <label>Fascia oraria</label>
        <div class="fasce">
          <label class="fascia-opt"><input type="radio" name="fascia" value="standard" checked/><span>Standard<small>entro 4h · €70</small></span></label>
          <label class="fascia-opt"><input type="radio" name="fascia" value="urgente"/><span>Urgente<small>entro 1,5h · €120</small></span></label>
          <label class="fascia-opt"><input type="radio" name="fascia" value="notte_festivo"/><span>Serale/Festivi<small>€200</small></span></label>
        </div>
      </div>
      <div class="prezzo-box">
        <div><div class="lbl">Costo di uscita</div><div class="sub">presa in carico — esclusi materiali e riparazione</div></div>
        <div class="val" id="prezzo">—</div>
      </div>
      <div class="field">
        <label for="descrizione">Descrizione del problema (opzionale)</label>
        <textarea id="descrizione" rows="3" placeholder="Descrivi brevemente il problema: cosa non funziona, quando è successo..."></textarea>
      </div>
      <!-- FATTURA -->
      <div class="fattura-toggle-row" onclick="toggleFattura()">
        <input type="checkbox" id="richiede-fattura" onclick="event.stopPropagation();toggleFattura()"/>
        <label for="richiede-fattura" style="cursor:pointer;font-size:.88rem;color:#374151"><strong>Richiedo fattura</strong> <span style="font-weight:400;opacity:.6">(opzionale)</span></label>
      </div>
      <div id="fattura-fields" style="display:none">
        <div class="row">
          <div class="field"><label for="codiceFiscale">Codice Fiscale</label><input type="text" id="codiceFiscale" placeholder="RSSMRA80A01H501U" maxlength="16" style="text-transform:uppercase"/></div>
          <div class="field"><label for="partitaIva">Partita IVA <span style="font-weight:400;opacity:.6">(se azienda)</span></label><input type="text" id="partitaIva" placeholder="12345678901" maxlength="11"/></div>
        </div>
        <div class="row">
          <div class="field"><label for="ragioneSociale">Ragione Sociale / Nome</label><input type="text" id="ragioneSociale" placeholder="Mario Rossi o ACME Srl" maxlength="100"/></div>
          <div class="field"><label for="pecSdi">PEC / Codice SDI</label><input type="text" id="pecSdi" placeholder="mario@pec.it oppure XXXXXXX" maxlength="100"/></div>
        </div>
        <div class="fattura-note">📋 I dati fiscali vengono trasmessi al tecnico per l'emissione della fattura a fine lavori.</div>
      </div>

      <div class="audio-section">
        <span class="audio-lbl">🎤 Messaggio vocale (opzionale — max 30 sec)</span>
        <div class="audio-btn-row">
          <button type="button" id="btn-audio" class="btn-audio">🎤 Registra audio</button>
          <span id="audio-timer" class="audio-timer" style="display:none">0:00</span>
          <button type="button" id="btn-stop-audio" class="btn-audio recording" style="display:none">⏹ Stop</button>
        </div>
        <div class="audio-preview" id="audio-preview">
          <audio id="audio-playback" controls></audio>
          <button type="button" class="audio-clear" id="btn-clear-audio">✕ Rimuovi</button>
        </div>
      </div>
      <div class="foto-section">
        <span class="foto-lbl">📷 Foto del problema (opzionale — max 5 foto)</span>
        <label class="foto-btn" for="input-foto">📷 Aggiungi foto dalla galleria o fotocamera</label>
        <input type="file" id="input-foto" accept="image/*" multiple capture="environment" style="display:none"/>
        <div class="foto-previews" id="foto-previews"></div>
      </div>
      <div class="accetta-row" data-tos-row="form" onclick="if(event.target.tagName!=='A')document.getElementById('accetta').click()">
        <input type="checkbox" id="accetta" data-tos-checkbox required onclick="event.stopPropagation()"/>
        <label for="accetta">Ho letto e accetto i <a href="/termini-servizio" class="tos-link" data-tos-open target="_blank" rel="noopener" style="color:#dc2626;text-decoration:underline;font-weight:700">Termini di Servizio</a>, incluse le clausole sul diritto di chiamata e i tempi indicativi.</label>
      </div>
      <div class="tos-error-msg" data-tos-error="form">⚠️ Devi accettare i Termini di Servizio per procedere.</div>
      <div class="trust-row">
        <span>✅ Tecnico verificato</span>
        <span>✅ Senza impegno</span>
        <span>🔒 Privacy garantita</span>
      </div>
      <button type="submit" class="submit-btn cta-disabled" data-tos-cta="form">Invia richiesta →</button>
      <div id="messaggio"></div>
      <div class="pay-section" id="pay-section">
        <div class="pay-header">
          <div class="pay-check">✅</div>
          <div class="pay-title">Richiesta ricevuta!</div>
          <div class="pay-desc">Inserisci la carta per <strong>confermare l'intervento</strong>. Il tecnico viene inviato solo dopo la conferma.</div>
          <div class="pay-urgency">⚡ Intervento entro 60–90 minuti</div>
        </div>
        <div class="pay-body">
          <div style="display:flex;flex-direction:column;gap:.5rem;margin-bottom:1rem">
            <div style="background:#fef9c3;color:#713f12;border:1px solid #fde68a;border-radius:.5rem;padding:.6rem .85rem;font-size:.8rem;line-height:1.5">
              🔐 <strong>Conferma intervento con pre-autorizzazione.</strong><br>Nessun addebito immediato sulla carta.
            </div>
            <div style="background:#f0f9ff;color:#0c4a6e;border:1px solid #bae6fd;border-radius:.5rem;padding:.6rem .85rem;font-size:.8rem;line-height:1.5">
              ℹ️ L'importo copre uscita e diagnosi. Eventuali lavorazioni e materiali sono esclusi e concordati sul posto.
            </div>
            <div style="background:#f9f9f9;color:#374151;border:1px solid #e5e7eb;border-radius:.5rem;padding:.6rem .85rem;font-size:.8rem;line-height:1.5">
              🕐 Tempi indicativi variabili in base a disponibilità e traffico.
            </div>
            <div style="background:#f0fdf4;color:#166534;border:1px solid #bbf7d0;border-radius:.5rem;padding:.6rem .85rem;font-size:.8rem;line-height:1.5">
              💳 Al termine dell'intervento puoi pagare <strong>con carta</strong> (addebito eseguito) oppure <strong>in contanti</strong> (pre-autorizzazione annullata e fondi sbloccati).
            </div>
          </div>
          <a id="pay-link" href="/api/paga?fascia=urgente" target="_blank" rel="noopener noreferrer" class="pay-btn">
            🔐 CONFERMA INTERVENTO – <span id="pay-link-price">€120</span>
          </a>
          <div style="text-align:center;font-size:.75rem;color:#6b7280;margin-top:.3rem;margin-bottom:.5rem">Nessun addebito immediato</div>
          <div class="pay-safe">
            <span>💳 Carta, Apple Pay, Google Pay</span>
            <span>🔒 Pagamento sicuro Stripe</span>
          </div>
          <a class="pay-call" href="tel:+393405707813">📞 Preferisci chiamare? 340 570 7813</a>
          <button type="button" class="pay-skip" onclick="document.getElementById('pay-section').classList.remove('show')">Preferisco pagare in contanti sul posto →</button>
        </div>
      </div>
    </form>
  </div>
</section>

<!-- FOOTER -->
<footer>
  <strong>prontointerventomi.it</strong> — by ELETTROTECH<br>
  Pronto Intervento Milano · H24 · 7 giorni su 7<br>
  <a href="tel:+393405707813">📞 340 570 7813</a> · <a href="mailto:info@prontointerventomi.it">info@prontointerventomi.it</a><br>
  <span style="opacity:.5;font-size:.68rem;margin-top:.4rem;display:block">© 2026 prontointerventomi.it — Tutti i diritti riservati</span>
</footer>

<!-- TOAST MESSAGGIO TARIFFA -->
<div id="price-toast" class="price-toast"></div>

<!-- STICKY BOTTOM BAR -->
<div class="sticky-bar" style="justify-content:center">
  <a id="sticky-pay-link" class="sticky-pay cta-disabled" data-tos-cta="hero" href="/api/paga?fascia=urgente" target="_blank" rel="noopener noreferrer" style="max-width:420px;flex:1">
    <strong id="sticky-pay-label">🔒 BLOCCA TECNICO ORA</strong>
    <span id="sticky-pay-price">€120 · Nessun addebito subito</span>
  </a>
</div>
<div class="sticky-scarcity">⚡ Pochi slot disponibili in questo momento</div>

<!-- MODAL TERMINI DI SERVIZIO -->
<div class="tos-modal-overlay" id="tos-modal" role="dialog" aria-modal="true" aria-labelledby="tos-modal-title">
  <div class="tos-modal">
    <button type="button" class="tos-modal-close" id="tos-modal-close" aria-label="Chiudi">×</button>
    <h2 id="tos-modal-title">Termini di Servizio</h2>
    <p class="ver">Versione v1.0-2026-04-25 · Ultimo aggiornamento: 25 aprile 2026</p>
    <h3>1. Identità del fornitore</h3>
    <p>Il sito <strong>prontointerventomi.it</strong> è gestito da <strong>ELETTROTECH</strong>, intermediario tecnologico per prenotazione di interventi tecnici a Milano e provincia.</p>
    <h3>2. Oggetto del servizio</h3>
    <p>La piattaforma consente di prenotare l'<strong>uscita di un tecnico qualificato</strong> per diagnosi di guasti su impianti elettrici. L'importo pagato copre <strong>esclusivamente uscita e diagnosi</strong>. Riparazioni e materiali sono sempre <strong>preventivati prima</strong>.</p>
    <h3>3. Tariffe</h3>
    <ul>
      <li><strong>Standard</strong> (entro 4 ore, feriale): €70</li>
      <li><strong>Urgente</strong> (60–90 min, feriale): €120</li>
      <li><strong>Serale / Festivi</strong>: €200</li>
      <li><strong>Prioritario locali commerciali</strong>: €350</li>
    </ul>
    <h3>4. Modalità di pagamento</h3>
    <p>Pagamento tramite <strong>Stripe</strong>. L'importo viene <strong>solo pre-autorizzato</strong>: nessun addebito immediato. Addebito effettivo solo a intervento eseguito.</p>
    <h3>5. Diritto di recesso</h3>
    <p>Trattandosi di servizi urgenti su richiesta del cliente, ai sensi dell'art. 59 lett. a) Cod. Cons. il recesso non si applica una volta avviata l'erogazione. Annullamento gratuito finché il tecnico non si è messo in viaggio.</p>
    <h3>6. Trattamento dati</h3>
    <p>Dati trattati ai sensi del Reg. UE 2016/679 (GDPR). All'accettazione registriamo <strong>indirizzo IP, user-agent e timestamp</strong> come prova del consenso.</p>
    <h3>7. Limitazione di responsabilità</h3>
    <p>Responsabilità tecnica in capo al tecnico incaricato. Foro competente: Milano (salvo diritti inderogabili del consumatore).</p>
    <p style="margin-top:1rem;font-size:.82rem"><a href="/termini-servizio" target="_blank" style="color:#0ea5e9;font-weight:600">→ Apri versione completa in nuova pagina</a></p>
    <div class="tos-modal-actions">
      <button type="button" class="tos-cancel" id="tos-modal-cancel">Chiudi</button>
      <button type="button" class="tos-accept" id="tos-modal-accept">Ho letto e accetto</button>
    </div>
  </div>
</div>
<script>
/* Fascia iniettata dal server (sempre corretta — Europe/Rome) */
var FASCIA_FESTIVA_SERVER = "__FASCIA_FESTIVA_SERVER__";

/* ── TOS: accettazione Termini di Servizio (obbligatoria pre-pagamento) ── */
(function(){
  function getCheckboxFor(group){
    if(group==="hero")   return document.getElementById("tos-hero");
    if(group==="locali") return document.getElementById("tos-locali");
    if(group==="form")   return document.getElementById("accetta");
    return null;
  }
  function syncCtaForGroup(group){
    var cb = getCheckboxFor(group);
    var checked = !!(cb && cb.checked);
    document.querySelectorAll("[data-tos-cta='" + group + "']").forEach(function(btn){
      if(checked) btn.classList.remove("cta-disabled");
      else        btn.classList.add("cta-disabled");
    });
  }
  function syncAllCta(){ ["hero","locali","form"].forEach(syncCtaForGroup); }
  function showTosError(group){
    var row = document.querySelector("[data-tos-row='" + group + "']");
    var err = document.querySelector("[data-tos-error='" + group + "']");
    if(row){
      row.classList.add("tos-error");
      try{ row.scrollIntoView({behavior:"smooth", block:"center"}); }catch(e){}
      setTimeout(function(){ row.classList.remove("tos-error"); }, 800);
    }
    if(err){
      err.classList.add("show");
      setTimeout(function(){ err.classList.remove("show"); }, 5000);
    }
  }
  function hideTosError(group){
    var err = document.querySelector("[data-tos-error='" + group + "']");
    if(err) err.classList.remove("show");
  }
  // Listener checkbox → aggiorna stato CTA
  document.querySelectorAll("[data-tos-checkbox]").forEach(function(cb){
    cb.addEventListener("change", function(){
      var row = cb.closest("[data-tos-row]");
      var group = row ? row.getAttribute("data-tos-row") : null;
      if(group){
        syncCtaForGroup(group);
        if(cb.checked) hideTosError(group);
      }
    });
  });
  // Click su qualsiasi CTA con data-tos-cta: blocca se non spuntato, altrimenti aggiunge tos=1
  document.addEventListener("click", function(e){
    var cta = e.target.closest("[data-tos-cta]");
    if(!cta) return;
    var group = cta.getAttribute("data-tos-cta");
    var cb = getCheckboxFor(group);
    if(!cb || !cb.checked){
      e.preventDefault();
      e.stopPropagation();
      showTosError(group);
      return false;
    }
    // Spunta presente: aggiungi tos=1 e tos_ts al href (solo per <a>, non form button)
    if(cta.tagName === "A" && cta.href){
      try{
        var u = new URL(cta.href, window.location.origin);
        u.searchParams.set("tos", "1");
        u.searchParams.set("tos_ts", new Date().toISOString());
        cta.href = u.toString();
      }catch(err){}
    }
  }, true);
  // Modal: apertura
  document.querySelectorAll("[data-tos-open]").forEach(function(a){
    a.addEventListener("click", function(e){
      // Se ctrl/cmd-click o middle-click lascia aprire in nuova tab
      if(e.ctrlKey||e.metaKey||e.button===1) return;
      e.preventDefault();
      var m = document.getElementById("tos-modal");
      if(m){ m.classList.add("show"); document.body.style.overflow = "hidden"; }
    });
  });
  // Modal: chiusura
  function closeTosModal(){
    var m = document.getElementById("tos-modal");
    if(m){ m.classList.remove("show"); document.body.style.overflow = ""; }
  }
  var btnClose = document.getElementById("tos-modal-close");
  if(btnClose) btnClose.addEventListener("click", closeTosModal);
  var btnCancel = document.getElementById("tos-modal-cancel");
  if(btnCancel) btnCancel.addEventListener("click", closeTosModal);
  var overlay = document.getElementById("tos-modal");
  if(overlay) overlay.addEventListener("click", function(e){ if(e.target === overlay) closeTosModal(); });
  // Modal: bottone "Ho letto e accetto" → spunta tutte le checkbox TOS
  var btnAccept = document.getElementById("tos-modal-accept");
  if(btnAccept) btnAccept.addEventListener("click", function(){
    document.querySelectorAll("[data-tos-checkbox]").forEach(function(cb){
      if(!cb.checked){
        cb.checked = true;
        cb.dispatchEvent(new Event("change", {bubbles:true}));
      }
    });
    closeTosModal();
  });
  // Esc per chiudere il modal
  document.addEventListener("keydown", function(e){
    if(e.key === "Escape"){
      var m = document.getElementById("tos-modal");
      if(m && m.classList.contains("show")) closeTosModal();
    }
  });
  // Sync iniziale
  syncAllCta();
})();

/* ── PRICE CARD SELECTION + VALIDAZIONE ORARIA ── */
const OPZIONI=[
  {nome:'Standard',    tempo:'Entro 4 ore',           prezzo:'€70',  fascia:'standard',     link:'/api/paga?fascia=standard'},
  {nome:'Urgente',     tempo:'Entro 60–90 min',        prezzo:'€120', fascia:'urgente',       link:'/api/paga?fascia=urgente'},
  {nome:'Serale/Fest', tempo:'Intervento prioritario', prezzo:'€200', fascia:'notte_festivo', link:'/api/paga?fascia=notte_festivo'},
];

/* Festività italiane fisse + Pasqua/Pasquetta 2026 */
const FESTIVITA_IT=[
  '01-01','01-06',             // Capodanno, Epifania
  '04-05','04-06',             // Pasqua/Pasquetta 2026
  '04-25','05-01','06-02',     // Liberazione, Lavoro, Repubblica
  '08-15',                     // Ferragosto
  '11-01','12-08',             // Ognissanti, Immacolata
  '12-25','12-26',             // Natale, S.Stefano
];

/* Ritorna data/ora corrente in fuso Europa/Roma (indipendente dal device) */
function italianNow(){
  try{
    const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Rome',weekday:'short',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date());
    const get=k=>{const p=parts.find(x=>x.type===k);return p?p.value:'';};
    const wkMap={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6};
    let h=parseInt(get('hour'),10); if(h===24)h=0;
    return{dow:wkMap[get('weekday')],h:h,mm:get('month'),dd:get('day')};
  }catch(e){
    const n=new Date();
    return{dow:n.getDay(),h:n.getHours(),mm:String(n.getMonth()+1).padStart(2,'0'),dd:String(n.getDate()).padStart(2,'0')};
  }
}

function isFestivita(){
  const t=italianNow();
  return FESTIVITA_IT.includes(t.mm+'-'+t.dd);
}

/* Restituisce true se l'opzione idx è disponibile ORA */
function isDisponibile(idx){
  const t=italianNow();
  const dow=t.dow;  // 0=Dom, 6=Sab
  const h=t.h;
  const isWeekday=dow>=1&&dow<=5;
  const isFestivo=!isWeekday||isFestivita();
  const isOrarioDiurno=h>=8&&h<17;
  if(idx===0||idx===1){
    // Standard e Urgente: solo feriali 08-17
    return isWeekday&&!isFestivita()&&isOrarioDiurno;
  }
  if(idx===2){
    // Serale/Festivi: fuori dall'orario diurno feriale
    return isFestivo||!isOrarioDiurno;
  }
  return false;
}

/* Toast */
let _toastTimer=null;
function mostraToast(msg){
  const t=document.getElementById('price-toast');
  if(!t)return;
  t.textContent=msg;
  t.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer=setTimeout(()=>t.classList.remove('show'),4000);
}

/* Applica classe unavail e aggiunge etichetta orario */
function aggiornaDisponibilita(){
  const t=italianNow();
  const dow=t.dow;
  const h=t.h;
  const isWeekday=dow>=1&&dow<=5&&!isFestivita();
  const isOrarioDiurno=h>=8&&h<17;
  // etichetta contestuale sopra le card
  const lbl=document.getElementById('price-avail-label');
  if(lbl){
    if(isWeekday&&isOrarioDiurno){
      lbl.className='price-avail-label day';
      lbl.textContent='🟢 Orario feriale — Disponibili: Standard e Urgente';
    } else {
      lbl.className='price-avail-label night';
      lbl.textContent='🔵 Orario serale/festivo — Disponibile: Serale/Festivi';
    }
  }
  // aggiorna classi card
  document.querySelectorAll('.price-card').forEach((c,i)=>{
    if(isDisponibile(i)){c.classList.remove('unavail');}
    else{c.classList.add('unavail');c.classList.remove('selected');}
  });
  // ── Disabilita / abilita radio della fascia nel form e seleziona uno valido ──
  const FASCIA_TO_IDX={standard:0,urgente:1,notte_festivo:2};
  const radios=document.querySelectorAll('input[name=fascia]');
  let primoValido=null,attualeValido=false;
  radios.forEach(r=>{
    const idx=FASCIA_TO_IDX[r.value];
    const ok=isDisponibile(idx);
    r.disabled=!ok;
    const wrap=r.closest('.fascia-opt');
    if(wrap){wrap.style.opacity=ok?'1':'0.4';wrap.style.pointerEvents=ok?'auto':'none';}
    if(ok&&!primoValido)primoValido=r;
    if(ok&&r.checked)attualeValido=true;
  });
  if(!attualeValido&&primoValido){
    primoValido.checked=true;
    primoValido.dispatchEvent(new Event('change'));
  }
  if(typeof aggiornaPrezzo==='function')aggiornaPrezzo();
}

let _selOpt=-1;
function selectOpzione(idx){
  const opt=OPZIONI[idx];
  // aggiorna SEMPRE il prezzo visualizzato sulla barra arancione
  const hp=document.getElementById('hero-pay-price');
  if(hp)hp.textContent=opt.prezzo;
  // aggiorna cards visivamente
  document.querySelectorAll('.price-card').forEach((c,i)=>{
    if(i===idx)c.classList.add('selected'); else c.classList.remove('selected');
  });
  // aggiorna sticky bar prezzo
  const sp=document.getElementById('sticky-pay-price');
  if(sp)sp.textContent=opt.nome+' '+opt.prezzo;
  // se non disponibile: mostra avviso e disabilita il link pagamento
  if(!isDisponibile(idx)){
    mostraToast('⚠️ Tariffa non disponibile in questo orario.\\nContattaci per accordarsi.');
    const cta=document.getElementById('hero-pay-cta');
    if(cta){cta.style.opacity='0.5';cta.style.pointerEvents='none';}
    return;
  }
  _selOpt=idx;
  // riabilita pagamento e aggiorna link
  const cta=document.getElementById('hero-pay-cta');
  if(cta){cta.style.opacity='';cta.style.pointerEvents='';cta.href=opt.link;}
  const sl=document.getElementById('sticky-pay-link');
  if(sl)sl.href=opt.link;
  const pl=document.getElementById('pay-link');
  if(pl)pl.href=opt.link;
  const plp=document.getElementById('pay-link-price');
  if(plp)plp.textContent=opt.prezzo;
  // sincronizza fascia nel form
  const radio=document.querySelector('input[name=fascia][value="'+opt.fascia+'"]');
  if(radio&&!radio.checked){radio.checked=true;radio.dispatchEvent(new Event('change'));}
}

/* Init: collega click delle card, applica disponibilità, seleziona prima valida */
document.querySelectorAll('.price-card').forEach(function(card,i){
  card.addEventListener('click',function(){selectOpzione(i);});
});
aggiornaDisponibilita();
(function(){
  const preferenza=[1,0,2]; // preferisci Urgente, poi Standard, poi Serale
  for(const i of preferenza){if(isDisponibile(i)){selectOpzione(i);break;}}
  // aggiorna ogni minuto (cambio orario)
  setInterval(()=>{aggiornaDisponibilita();},60000);
})();

/* ── SCARSITÀ DINAMICA ── */
(function(){
  let tecniciDisponibili=1;
  const mainEl=document.getElementById('scarcity-main');
  const subEl=document.getElementById('scarcity-sub');
  function aggiornaScarsita(){
    if(!mainEl||!subEl)return;
    if(tecniciDisponibili<=0){
      mainEl.textContent='⛔ Nessuna disponibilità immediata – riprova tra poco';
      mainEl.style.color='#f87171';
      subEl.textContent='';
    } else {
      mainEl.textContent='⚡ '+tecniciDisponibili+' tecnico disponibile in zona';
      mainEl.style.color='#fca5a5';
      subEl.textContent="A causa dell'elevata richiesta, la disponibilità è limitata";
    }
  }
  // Decrementa al click su uno qualsiasi dei bottoni di pagamento
  document.querySelectorAll('#hero-pay-cta, .hero-pay-cta, #sticky-pay-link').forEach(function(btn){
    btn.addEventListener('click',function(){
      if(tecniciDisponibili>0){tecniciDisponibili--;aggiornaScarsita();}
    });
  });
  aggiornaScarsita();
})();

const LISTINO=${JSON.stringify(LISTINO)};
function eur(c){return (c/100).toFixed(2).replace('.',',')+' €';}
function aggiornaPrezzo(){
  const s=document.getElementById('servizio').value;
  const f=document.querySelector('input[name=fascia]:checked').value;
  const p=document.getElementById('prezzo');
  if(!s||!LISTINO[s]){p.textContent='—';return;}
  p.textContent=eur(LISTINO[s][f]);
}
document.getElementById('servizio').addEventListener('change',aggiornaPrezzo);
document.querySelectorAll('input[name=fascia]').forEach(r=>r.addEventListener('change',aggiornaPrezzo));
document.getElementById('geo-btn').addEventListener('click',function(){
  const btn=this,status=document.getElementById('geo-status');
  if(!navigator.geolocation){status.textContent='Geolocalizzazione non supportata dal browser.';status.className='geo-status err';return;}
  btn.disabled=true;status.textContent='Rilevamento posizione in corso...';status.className='geo-status';
  navigator.geolocation.getCurrentPosition(async pos=>{
    try{
      const {latitude:lat,longitude:lon}=pos.coords;
      const r=await fetch('https://nominatim.openstreetmap.org/reverse?format=json&lat='+lat+'&lon='+lon+'&zoom=18&addressdetails=1&accept-language=it',{headers:{'Accept':'application/json'}});
      const d=await r.json();
      const a=d.address||{};
      const via=[a.road||a.pedestrian||a.footway||'',a.house_number||''].filter(Boolean).join(' ');
      const citta=a.city||a.town||a.village||a.municipality||a.suburb||'';
      const indirizzo=[via,citta].filter(Boolean).join(', ');
      const cap=a.postcode||'';
      if(indirizzo)document.getElementById('indirizzo').value=indirizzo;
      if(cap)document.getElementById('cap').value=cap;
      if(indirizzo||cap){status.textContent='\u2713 Posizione rilevata. Verifica e correggi se necessario.';status.className='geo-status ok';}
      else{status.textContent='Posizione trovata ma indirizzo non disponibile. Inserisci manualmente.';status.className='geo-status err';}
    }catch(e){status.textContent='Errore nel recupero indirizzo. Inserisci manualmente.';status.className='geo-status err';}
    finally{btn.disabled=false;}
  },err=>{
    btn.disabled=false;
    const msg=err.code===1?'Permesso negato. Abilita la localizzazione nel browser.':err.code===2?'Posizione non disponibile.':'Timeout. Riprova.';
    status.textContent=msg;status.className='geo-status err';
  },{enableHighAccuracy:true,timeout:10000,maximumAge:60000});
});
function toggleCondizioni(){
  document.getElementById('condizioni-lista').classList.toggle('open');
  document.querySelector('.condizioni-toggle').classList.toggle('open');
}
function toggleFattura(){
  const cb=document.getElementById('richiede-fattura');
  const fields=document.getElementById('fattura-fields');
  if(cb&&fields){fields.style.display=cb.checked?'block':'none';}
}
// ── DISPONIBILITÀ GLOBALE ─────────────────────────────────────
(function(){
  fetch('/api/disponibilita').then(r=>r.json()).then(function(d){
    if(d.disponibile!==false)return;
    // Mostra banner
    const banner=document.getElementById('avail-offline-banner');
    if(banner)banner.style.display='block';
    // Disabilita card prezzi
    document.querySelectorAll('.price-card').forEach(function(c){
      c.style.opacity='.35';c.style.pointerEvents='none';c.classList.remove('selected');
    });
    // Disabilita tag "Tecnico disponibile"
    const tag=document.querySelector('.avail-tag');
    if(tag){tag.innerHTML='<span style="color:#ef4444;font-size:.85rem;margin-right:.3rem">●</span> Servizio temporaneamente sospeso';tag.style.background='rgba(239,68,68,.12)';tag.style.color='#ef4444';}
    // Disabilita etichetta orario
    const lbl=document.getElementById('price-avail-label');
    if(lbl){lbl.textContent='⚠️ Prenotazioni momentaneamente sospese';lbl.style.background='#fef2f2';lbl.style.color='#991b1b';}
    // Disabilita form
    const form=document.getElementById('formr');
    if(form){
      form.querySelectorAll('input,select,textarea,button').forEach(function(el){el.disabled=true;});
    }
    // Disabilita CTA
    ['hero-pay-cta','sticky-pay-link','pay-link'].forEach(function(id){
      const el=document.getElementById(id);
      if(el){el.style.opacity='.35';el.style.pointerEvents='none';}
    });
    document.querySelectorAll('.s-cta,a.btn-red').forEach(function(a){a.style.opacity='.35';a.style.pointerEvents='none';});
  }).catch(function(){});
})();

// ── RITORNO DA STRIPE ─────────────────────────────────────────
(function(){
  const p=new URLSearchParams(window.location.search);
  if(p.has('pagamento')){
    const ok=p.get('pagamento')==='ok';
    const banner=document.createElement('div');
    banner.style.cssText='position:fixed;top:0;left:0;right:0;z-index:9999;padding:1rem 1.5rem;text-align:center;font-weight:700;font-size:.95rem;font-family:inherit;'+(ok?'background:#065f46;color:#d1fae5;':'background:#7f1d1d;color:#fecaca;');
    banner.textContent=ok?'✅ Pagamento ricevuto! Ti contatteremo a breve per confermare il tecnico.':'❌ Pagamento non completato. Puoi riprovare dal form.';
    document.body.prepend(banner);
    setTimeout(()=>banner.remove(),9000);
    window.history.replaceState({},'','/');
  }
})();

// ── AUDIO RECORDER ────────────────────────────────────────────
let mediaRec=null,audioBlob=null,audioChunks=[],recTimer=null,recSecs=0;
const MAX_REC_SEC=30;
async function startAudio(){
  try{
    const stream=await navigator.mediaDevices.getUserMedia({audio:true});
    audioChunks=[];audioBlob=null;recSecs=0;
    const opts=typeof MediaRecorder!=='undefined'&&MediaRecorder.isTypeSupported('audio/webm')?{mimeType:'audio/webm'}:{};
    mediaRec=new MediaRecorder(stream,opts);
    mediaRec.ondataavailable=e=>{if(e.data&&e.data.size>0)audioChunks.push(e.data);};
    mediaRec.onstop=()=>{
      stream.getTracks().forEach(t=>t.stop());
      const mime=mediaRec.mimeType||'audio/webm';
      audioBlob=new Blob(audioChunks,{type:mime});
      document.getElementById('audio-playback').src=URL.createObjectURL(audioBlob);
      document.getElementById('audio-preview').style.display='flex';
      document.getElementById('btn-audio').style.display='';
      document.getElementById('btn-stop-audio').style.display='none';
      document.getElementById('audio-timer').style.display='none';
      clearInterval(recTimer);
    };
    mediaRec.start(100);
    document.getElementById('btn-audio').style.display='none';
    document.getElementById('btn-stop-audio').style.display='';
    document.getElementById('audio-timer').style.display='';
    recTimer=setInterval(()=>{
      recSecs++;
      const m=Math.floor(recSecs/60),s=recSecs%60;
      document.getElementById('audio-timer').textContent=m+':'+(s<10?'0':'')+s;
      if(recSecs>=MAX_REC_SEC)stopAudio();
    },1000);
  }catch(e){alert('Impossibile accedere al microfono. Controlla i permessi del browser.');}
}
function stopAudio(){if(mediaRec&&mediaRec.state==='recording'){mediaRec.stop();clearInterval(recTimer);}}
function clearAudio(){
  audioBlob=null;
  document.getElementById('audio-preview').style.display='none';
  document.getElementById('audio-playback').src='';
}
document.getElementById('btn-audio').addEventListener('click',startAudio);
document.getElementById('btn-stop-audio').addEventListener('click',stopAudio);
document.getElementById('btn-clear-audio').addEventListener('click',clearAudio);

// ── PWA SERVICE WORKER ─────────────────────────────────────────
if('serviceWorker' in navigator){
  navigator.serviceWorker.register('/sw.js').then(reg=>{
    reg.update();
    reg.addEventListener('updatefound',()=>{
      const sw=reg.installing;
      if(!sw)return;
      sw.addEventListener('statechange',()=>{
        if(sw.state==='activated')window.location.reload();
      });
    });
  }).catch(()=>{});
  // Rimuovi eventuali SW vecchi con cache obsoleta
  navigator.serviceWorker.getRegistrations().then(regs=>{
    regs.forEach(r=>r.update());
  });
}

// ── FOTO UPLOAD ───────────────────────────────────────────────
let fotoFiles=[];
document.getElementById('input-foto').addEventListener('change',function(){
  const files=Array.from(this.files||[]);
  fotoFiles=[...fotoFiles,...files].slice(0,5);
  renderFoto();this.value='';
});
function renderFoto(){
  const c=document.getElementById('foto-previews');c.innerHTML='';
  fotoFiles.forEach((f,i)=>{
    const url=URL.createObjectURL(f);
    const wrap=document.createElement('div');wrap.className='foto-thumb-wrap';
    const img=document.createElement('img');img.src=url;img.className='foto-thumb';
    const btn=document.createElement('button');btn.type='button';btn.className='foto-remove';btn.textContent='x';
    btn.onclick=()=>{fotoFiles.splice(i,1);renderFoto();};
    wrap.append(img,btn);c.append(wrap);
  });
}

// ── HELPER: Blob a base64 ─────────────────────────────────────
function blobToB64(blob){
  return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=rej;r.readAsDataURL(blob);});
}

// ── FORM SUBMIT ───────────────────────────────────────────────
document.getElementById('formr').addEventListener('submit',async function(e){
  e.preventDefault();
  if(!document.getElementById('accetta').checked){
    var rowF=document.querySelector('[data-tos-row="form"]');
    var errF=document.querySelector('[data-tos-error="form"]');
    if(rowF){rowF.classList.add('tos-error');try{rowF.scrollIntoView({behavior:'smooth',block:'center'});}catch(e){}setTimeout(function(){rowF.classList.remove('tos-error');},800);}
    if(errF){errF.classList.add('show');setTimeout(function(){errF.classList.remove('show');},5000);}
    alert('Devi accettare i Termini di Servizio per procedere.');
    return;
  }
  const btn=this.querySelector('button[type=submit]');
  btn.textContent='Invio in corso...';btn.disabled=true;
  document.getElementById('pay-section').classList.remove('show');
  try{
    const audio_b64=audioBlob?await blobToB64(audioBlob):null;
    const foto_b64=fotoFiles.length?await Promise.all(fotoFiles.map(blobToB64)):[];
    const emailVal=(document.getElementById('email')||{}).value||'';
    const richiedeFattura=document.getElementById('richiede-fattura')?.checked||false;
    const datiFatturazione=richiedeFattura?{
      codiceFiscale:(document.getElementById('codiceFiscale')?.value||'').trim().toUpperCase(),
      partitaIva:(document.getElementById('partitaIva')?.value||'').trim(),
      ragioneSociale:(document.getElementById('ragioneSociale')?.value||'').trim(),
      pecSdi:(document.getElementById('pecSdi')?.value||'').trim(),
    }:null;
    const data={
      nome:document.getElementById('nome').value,
      telefono:document.getElementById('telefono').value,
      email:emailVal,
      indirizzo:document.getElementById('indirizzo').value,
      cap:document.getElementById('cap').value,
      servizio:document.getElementById('servizio').value,
      fasciaOraria:document.querySelector('input[name=fascia]:checked').value,
      descrizione:document.getElementById('descrizione').value||'',
      accettazioneCondizioni:new Date().toISOString(),
      richiedeFattura,datiFatturazione,
      audio_b64,foto_b64
    };
    const res=await fetch('/richiesta',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    const json=await res.json();
    if(json.successo){
      this.reset();aggiornaPrezzo();fotoFiles=[];renderFoto();clearAudio();
      if(json.stripeUrl){
        window.location.href=json.stripeUrl;
      }else{
        const paySection=document.getElementById('pay-section');
        document.getElementById('pay-link').href=json.pagamentoUrl||'https://buy.stripe.com/7sYcN5chN5Pucha4nq1gs00';
        paySection.classList.add('show');
        setTimeout(()=>paySection.scrollIntoView({behavior:'smooth',block:'center'}),80);
      }
    }else{
      alert(json.errore||"Errore durante l'invio. Riprova.");
    }
  }catch(err){alert('Errore di rete. Controlla la connessione e riprova.');}
  finally{btn.textContent='Invia richiesta';btn.disabled=false;}
});
</script>
</body></html>`;

const TERMINI_HTML = `<!DOCTYPE html><html lang="it"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Termini di Servizio — prontointerventomi.it</title>
<style>
*{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f8fafc;color:#1e293b;margin:0;padding:2rem 1rem;line-height:1.7}
.container{max-width:780px;margin:0 auto;background:#fff;padding:2.2rem 2rem;border-radius:12px;box-shadow:0 4px 24px rgba(15,23,42,.08)}
h1{font-size:1.7rem;color:#0f172a;margin:0 0 .4rem}
.versione{color:#64748b;font-size:.85rem;margin-bottom:1.6rem;padding-bottom:1rem;border-bottom:1px solid #e2e8f0}
h2{font-size:1.15rem;color:#1e40af;margin-top:1.8rem;margin-bottom:.6rem}
p,li{font-size:.95rem;color:#334155}
ul,ol{padding-left:1.4rem}
li{margin-bottom:.4rem}
.back{display:inline-block;margin-top:2rem;padding:.7rem 1.2rem;background:#0ea5e9;color:#fff;text-decoration:none;border-radius:8px;font-weight:600}
.back:hover{background:#0284c7}
.nota{background:#fef3c7;border-left:4px solid #f59e0b;padding:1rem 1.2rem;border-radius:6px;margin:1.4rem 0;font-size:.9rem;color:#78350f}
</style></head><body>
<div class="container">
<h1>Termini di Servizio</h1>
<p class="versione">Versione ${TOS_VERSION} · Ultimo aggiornamento: 25 aprile 2026</p>

<div class="nota">
<strong>Accettazione richiesta.</strong> Selezionando la casella "Ho letto e accetto i Termini di Servizio" e proseguendo con il pagamento o l'invio della richiesta, dichiari di aver letto, compreso e accettato integralmente i presenti Termini. La data, l'ora e l'indirizzo IP della tua accettazione vengono registrati a fini di prova.
</div>

<h2>1. Identità del fornitore</h2>
<p>Il sito <strong>prontointerventomi.it</strong> è gestito da <strong>ELETTROTECH</strong>, che opera come intermediario tecnologico per la prenotazione di interventi tecnici (servizi elettrici e affini) sul territorio di Milano e provincia.</p>

<h2>2. Oggetto del servizio</h2>
<p>La piattaforma consente di richiedere e prenotare l'<strong>uscita di un tecnico qualificato</strong> per diagnosi di guasti su impianti elettrici. L'importo pagato copre <strong>esclusivamente l'uscita del tecnico e la diagnosi</strong>. Eventuali riparazioni, materiali o lavorazioni aggiuntive vengono <strong>sempre preventivate e concordate prima</strong> dell'esecuzione.</p>

<h2>3. Tariffe</h2>
<ul>
<li><strong>Standard (entro 4 ore, feriale):</strong> €70</li>
<li><strong>Urgente (60–90 min, feriale):</strong> €120</li>
<li><strong>Serale / Festivi:</strong> €200</li>
<li><strong>Intervento prioritario locali commerciali:</strong> €350</li>
</ul>
<p>Le tariffe sopra indicate sono onnicomprensive di uscita e diagnosi. Riparazioni e materiali sono esclusi.</p>

<h2>4. Modalità di pagamento</h2>
<p>Il pagamento avviene tramite <strong>Stripe</strong>. L'importo viene <strong>solo pre-autorizzato</strong> sulla carta al momento della prenotazione: nessun addebito immediato. L'addebito effettivo avviene solo a intervento eseguito. Se preferisci pagare in contanti sul posto, la pre-autorizzazione viene annullata e i fondi sbloccati.</p>

<h2>5. Diritto di recesso</h2>
<p>Trattandosi di servizi urgenti richiesti espressamente dal cliente con esecuzione immediata, ai sensi dell'art. 59 lett. a) del Codice del Consumo, il diritto di recesso non si applica una volta avviata l'erogazione. Puoi annullare gratuitamente la richiesta finché il tecnico non è stato assegnato e non si è messo in viaggio.</p>

<h2>6. Tempi di intervento</h2>
<p>I tempi indicati sono indicativi e dipendono da disponibilità del tecnico, traffico e condizioni operative. Non garantiscono un risultato vincolante in caso di forza maggiore.</p>

<h2>7. Ruolo della piattaforma</h2>
<p>prontointerventomi.it agisce come <strong>intermediario tecnologico</strong> tra cliente e tecnico professionista. Il tecnico opera come professionista autonomo e rilascia regolare documentazione fiscale.</p>

<h2>8. Trattamento dati personali</h2>
<p>I dati che fornisci (nome, telefono, indirizzo, email, eventuale audio/foto) sono trattati ai sensi del Reg. UE 2016/679 (GDPR) per la sola finalità di erogazione del servizio. Vengono inoltre registrati l'<strong>indirizzo IP</strong>, lo <strong>user-agent del browser</strong> e il <strong>timestamp</strong> al momento dell'accettazione di questi Termini, esclusivamente come prova del consenso.</p>

<h2>9. Limitazione di responsabilità</h2>
<p>La responsabilità tecnica relativa all'esecuzione dell'intervento è in capo al tecnico incaricato. La piattaforma non risponde di danni derivanti da un uso improprio dell'impianto da parte del cliente o da informazioni non veritiere fornite all'atto della prenotazione.</p>

<h2>10. Reclami e foro competente</h2>
<p>Per qualsiasi reclamo o richiesta è possibile contattare <a href="mailto:info@prontointerventomi.it">info@prontointerventomi.it</a>. Per controversie il foro competente è quello di Milano, salvo i diritti inderogabili del consumatore.</p>

<h2>11. Modifiche ai Termini</h2>
<p>I presenti Termini possono essere aggiornati. La versione applicabile è quella vigente al momento dell'accettazione, identificata dalla stringa di versione in alto. Lo storico delle versioni è conservato dal gestore.</p>

<a class="back" href="/">← Torna alla home</a>
</div>
</body></html>`;

app.get("/", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  // Inietta la fascia calcolata lato server (ora italiana precisa)
  const html = HTML_PAGE.replace('"__FASCIA_FESTIVA_SERVER__"', serverFasciaFestiva() ? 'true' : 'false');
  res.send(html);
});

app.get("/api/disponibilita", (_req, res) => {
  res.json({ disponibile: tecnicoDisponibile });
});

/* Fascia corretta ora italiana — mai cacheable, bypassa service worker */
app.get("/api/fascia", (_req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.json({ festiva: serverFasciaFestiva() });
});

app.post("/richiesta", async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const nome = String(body.nome ?? "").trim().slice(0, 100);
  const telefono = String(body.telefono ?? "").trim().slice(0, 30);
  const emailCliente = String(body.email ?? "").trim().slice(0, 200);
  const indirizzo = String(body.indirizzo ?? "").trim().slice(0, 200);
  const cap = String(body.cap ?? "").trim();
  const servizio = String(body.servizio ?? "").trim().toLowerCase();
  const fascia = String(body.fasciaOraria ?? "standard").trim().toLowerCase();
  const descrizione = String(body.descrizione ?? "").trim().slice(0, 1000);
  const accettazioneCondizioni = String(body.accettazioneCondizioni ?? "");
  const audio_b64 = typeof body.audio_b64 === "string" ? body.audio_b64 : null;
  const foto_b64 = Array.isArray(body.foto_b64) ? (body.foto_b64 as string[]).slice(0, 5) : [];
  const richiedeFattura = Boolean(body.richiedeFattura);
  const datiFatturazioneRaw = body.datiFatturazione && typeof body.datiFatturazione === "object"
    ? body.datiFatturazione as Record<string, string>
    : null;
  const datiFatturazioneStr = datiFatturazioneRaw ? JSON.stringify(datiFatturazioneRaw) : null;

  if (!tecnicoDisponibile) return res.status(503).json({ successo: false, errore: "Al momento non ci sono tecnici disponibili. Riprova più tardi o contattaci telefonicamente." });
  if (!nome || !telefono || !indirizzo) return res.status(400).json({ successo: false, errore: "Campi obbligatori mancanti" });
  if (!SERVIZI_VALIDI.has(servizio)) return res.status(400).json({ successo: false, errore: "Servizio non valido" });
  if (!FASCE_VALIDE.has(fascia)) return res.status(400).json({ successo: false, errore: "Fascia oraria non valida" });
  if (!CAP_REGEX.test(cap)) return res.status(400).json({ successo: false, errore: "CAP non valido" });
  if (!accettazioneCondizioni) return res.status(400).json({ successo: false, errore: "Devi accettare le condizioni" });

  const prezzo = calcolaPrezzo(servizio, fascia);
  req.log.info({ nome, telefono, servizio, cap, fascia, prezzo, hasAudio: !!audio_b64, numFoto: foto_b64.length }, "Nuova richiesta");

  const [record] = await db.insert(richiesteTable).values({
    nome, telefono, indirizzo, cap, servizio,
    fasciaOraria: fascia, prezzoUscitaCents: prezzo,
    accettazioneCondizioni,
    richiedeFattura: richiedeFattura ? "si" : null,
    datiFatturazione: datiFatturazioneStr,
  }).returning();

  // Audit accettazione TOS (form richiesta) — IP, user-agent, fascia, versione
  try {
    const ipReq = (req.ip || req.headers["x-forwarded-for"] || "").toString().slice(0, 100) || null;
    const uaReq = (req.headers["user-agent"] || "").toString().slice(0, 500) || null;
    await db.insert(tosAuditTable).values({
      contesto: "richiesta_form",
      fascia,
      ipAddress: ipReq,
      userAgent: uaReq,
      versione: TOS_VERSION,
      riferimentoRichiestaId: record.id,
      stripeSessionId: null,
    });
  } catch (e) {
    req.log.warn({ err: e }, "Salvataggio audit TOS fallito (richiesta form)");
  }

  // Trova tecnici candidati
  const tecniciDisponibili = await db.select().from(tecniciTable)
    .where(sql`${tecniciTable.attivo} = true AND ${servizio} = ANY(${tecniciTable.categorie}) AND ${cap} = ANY(${tecniciTable.capServiti})`)
    .orderBy(desc(tecniciTable.rating));

  // Righe notifica
  const righeNotifica = [
    `🚨 NUOVA RICHIESTA #${record.id}`,
    ``,
    `👤 ${nome}`,
    `📞 ${telefono}`,
    `📍 ${indirizzo} (${cap})`,
    `⚡ ${SERVIZIO_LABEL[servizio] ?? servizio}`,
    `🕐 ${FASCIA_LABEL[fascia] ?? fascia}`,
    `💶 Pre-autorizzazione: € ${(prezzo / 100).toFixed(2)}`,
    `🧾 Fattura: ${richiedeFattura ? "SÌ" : "No"}`,
    ...(richiedeFattura && datiFatturazioneRaw ? [
      ...(datiFatturazioneRaw.ragioneSociale ? [`   • Intestatario: ${datiFatturazioneRaw.ragioneSociale}`] : []),
      ...(datiFatturazioneRaw.partitaIva ? [`   • P.IVA: ${datiFatturazioneRaw.partitaIva}`] : []),
      ...(datiFatturazioneRaw.codiceFiscale ? [`   • CF: ${datiFatturazioneRaw.codiceFiscale}`] : []),
      ...(datiFatturazioneRaw.pecSdi ? [`   • PEC/SDI: ${datiFatturazioneRaw.pecSdi}`] : []),
    ] : []),
    ...(descrizione ? [`📝 ${descrizione}`] : []),
    `🔧 Tecnici disponibili in zona`,
  ];

  // Crea sessione Stripe dinamica collegata a questa richiesta specifica
  const proto = req.protocol;
  const host = req.get("host") ?? "";
  const baseUrl = `${proto}://${host}`;
  let stripeUrl: string | null = null;
  if (stripeEnabled) {
    stripeUrl = await creaCheckoutUscita({
      richiestaId: record.id,
      nome,
      servizio,
      indirizzo,
      prezzoUscitaCents: prezzo,
      baseUrl,
      emailCliente: emailCliente || undefined,
    });
  }
  const pagamentoUrl = stripeUrl ?? "https://buy.stripe.com/7sYcN5chN5Pucha4nq1gs00";

  // Notifica admin su tutti i canali
  notificaAdmin({
    titolo: `🚨 Nuova richiesta #${record.id} — ${nome}`,
    righe: [...righeNotifica, ...(emailCliente ? [`📧 ${emailCliente}`] : [])],
    audio_b64: audio_b64 ?? undefined,
    foto_b64: foto_b64.length > 0 ? foto_b64 : undefined,
  }).catch(() => {});

  // Email di conferma al cliente (se fornita)
  if (emailCliente && emailCliente.includes("@")) {
    inviaEmailCliente({
      nome,
      email: emailCliente,
      servizio: SERVIZIO_LABEL[servizio] ?? servizio,
      indirizzo,
      fascia: FASCIA_LABEL[fascia] ?? fascia,
      prezzoCents: prezzo,
      richiestaId: record.id,
    }).catch(() => {});
  }

  res.json({
    successo: true,
    messaggio: "Richiesta ricevuta",
    dati: record,
    tecniciTrovati: tecniciDisponibili.length,
    pagamentoUrl,
    stripeUrl,
  });
});

/* ── /api/paga?fascia=standard|urgente|notte_festivo ── */
/* Crea una sessione Stripe dinamica con il prezzo corretto e fa redirect */
const PAGA_LINK_FALLBACK = "https://buy.stripe.com/7sYcN5chN5Pucha4nq1gs00";
app.get("/api/paga", async (req, res) => {
  const fascia = String(req.query.fascia ?? "urgente");
  if (!FASCE_VALIDE.has(fascia)) return res.redirect(PAGA_LINK_FALLBACK);

  // BLOCCO OBBLIGATORIO: l'utente deve aver accettato i Termini di Servizio (?tos=1)
  const tosFlag = String(req.query.tos ?? "");
  if (tosFlag !== "1") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(400).send(
      `<!doctype html><meta charset="utf-8"><title>Accettazione richiesta</title>` +
      `<div style="font-family:system-ui;padding:2rem;max-width:600px;margin:auto;text-align:center">` +
      `<h2 style="color:#dc2626">⚠️ Accettazione richiesta</h2>` +
      `<p>You must accept the Terms of Service to proceed.</p>` +
      `<p>Devi accettare i Termini di Servizio per procedere.</p>` +
      `<p><a href="/" style="color:#0ea5e9">← Torna alla home e spunta la casella</a></p>` +
      `<p style="margin-top:1rem"><a href="/termini-servizio" target="_blank" style="color:#6b7280;font-size:.85rem">Leggi i Termini di Servizio</a></p></div>`
    );
  }

  // VALIDA che la fascia richiesta sia coerente con l'ora italiana attuale
  const festivaOra = serverFasciaFestiva();
  const fasciaFeriale = fascia === "standard" || fascia === "urgente";
  const fasciaFestiva = fascia === "notte_festivo";
  if ((fasciaFeriale && festivaOra) || (fasciaFestiva && !festivaOra)) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(409).send(
      `<!doctype html><meta charset="utf-8"><title>Tariffa non disponibile</title>` +
      `<div style="font-family:system-ui;padding:2rem;max-width:600px;margin:auto;text-align:center">` +
      `<h2 style="color:#dc2626">⚠️ Tariffa non disponibile</h2>` +
      `<p>Tariffa non disponibile per questa fascia oraria o giorno.</p>` +
      `<p><a href="/" style="color:#0ea5e9">← Torna alla home</a></p></div>`
    );
  }
  const prezzoUscitaCents = LISTINO["impianti_elettrici"]?.[fascia] ?? 12000;

  // Registra accettazione TOS (audit log) — IP, user-agent, fascia, versione
  const ipAddress = (req.ip || req.headers["x-forwarded-for"] || "").toString().slice(0, 100) || null;
  const userAgent = (req.headers["user-agent"] || "").toString().slice(0, 500) || null;
  try {
    await db.insert(tosAuditTable).values({
      contesto: "pagamento_diretto",
      fascia,
      ipAddress,
      userAgent,
      versione: TOS_VERSION,
      riferimentoRichiestaId: null,
      stripeSessionId: null,
    });
  } catch (e) {
    req.log.warn({ err: e }, "Salvataggio audit TOS fallito (pagamento diretto)");
  }

  if (!stripeEnabled) return res.redirect(PAGA_LINK_FALLBACK);
  try {
    const proto = req.protocol;
    const host = req.get("host") ?? "";
    const url = await creaCheckoutUscita({
      richiestaId: 0,
      nome: "Prenotazione diretta",
      servizio: "impianti_elettrici",
      indirizzo: "Milano",
      prezzoUscitaCents,
      baseUrl: `${proto}://${host}`,
    });
    if (!url) return res.redirect(PAGA_LINK_FALLBACK);
    return res.redirect(url);
  } catch (e) {
    req.log.error({ err: e }, "Checkout diretto fallito");
    return res.redirect(PAGA_LINK_FALLBACK);
  }
});

/* ── /termini-servizio — pagina pubblica con i Termini completi ── */
app.get("/termini-servizio", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(TERMINI_HTML);
});

/* ── /api/richiesta/:id/stato — polling pubblico ── */
app.get("/api/richiesta/:id/stato", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ errore: "ID non valido" });
  const [r] = await db.select({
    id: richiesteTable.id,
    stato: richiesteTable.stato,
    nome: richiesteTable.nome,
    servizio: richiesteTable.servizio,
    prezzoUscitaCents: richiesteTable.prezzoUscitaCents,
    tecnicoId: richiesteTable.tecnicoId,
  }).from(richiesteTable).where(eq(richiesteTable.id, id));
  if (!r) return res.status(404).json({ errore: "Richiesta non trovata" });
  const stato = STATO_LABEL[r.stato] ?? STATO_LABEL["in_attesa"];
  let tecnicoNome: string | null = null;
  if (r.tecnicoId) {
    const [t] = await db.select({ nome: tecniciTable.nome }).from(tecniciTable).where(eq(tecniciTable.id, r.tecnicoId));
    tecnicoNome = t?.nome ?? null;
  }
  res.json({ id: r.id, stato: r.stato, statoLabel: stato.txt, statoBg: stato.bg, statoCol: stato.col, tecnicoNome });
});

/* ── /pagamento-ok — pagina di successo dopo Stripe ── */
app.get("/pagamento-ok", async (req, res) => {
  const id = parseInt(String(req.query.id ?? ""), 10);
  let richiestaHtml = "";
  if (Number.isFinite(id) && id > 0) {
    const [r] = await db.select().from(richiesteTable).where(eq(richiesteTable.id, id));
    if (r) {
      const prezzoStr = eur(r.prezzoUscitaCents);
      richiestaHtml = `
        <div class="ok-detail">
          <div class="ok-row"><span>Prenotazione</span><strong>#${r.id}</strong></div>
          <div class="ok-row"><span>Nome</span><strong>${esc(r.nome)}</strong></div>
          <div class="ok-row"><span>Servizio</span><strong>${esc(SERVIZIO_LABEL[r.servizio] ?? r.servizio)}</strong></div>
          <div class="ok-row"><span>Indirizzo</span><strong>${esc(r.indirizzo)}</strong></div>
          <div class="ok-row"><span>Fascia</span><strong>${esc(FASCIA_LABEL[r.fasciaOraria] ?? r.fasciaOraria)}</strong></div>
          <div class="ok-row"><span>Costo uscita</span><strong class="ok-prezzo">${prezzoStr}</strong></div>
        </div>
        <div id="stato-box" class="ok-stato" style="background:${STATO_LABEL[r.stato]?.bg ?? "#fef3c7"};color:${STATO_LABEL[r.stato]?.col ?? "#92400e"}">
          <span id="stato-txt">${STATO_LABEL[r.stato]?.txt ?? r.stato}</span>
        </div>
        <script>
          (function(){
            var id=${r.id};
            function pollStato(){
              fetch('/api/richiesta/'+id+'/stato').then(r=>r.json()).then(function(d){
                var box=document.getElementById('stato-box');
                var txt=document.getElementById('stato-txt');
                if(box&&txt&&d.stato){
                  box.style.background=d.statoBg;box.style.color=d.statoCol;
                  txt.textContent=d.statoLabel+(d.tecnicoNome?' — '+d.tecnicoNome:'');
                  if(d.stato==='pagata'||d.stato==='completata')return;
                }
              }).catch(function(){});
              setTimeout(pollStato,8000);
            }
            setTimeout(pollStato,8000);
          })();
        <\/script>`;
    }
  }
  const html = `<!DOCTYPE html><html lang="it"><head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Pagamento completato — Pronto Intervento Milano</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:#f0f4f8;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem}
.card{background:#fff;border-radius:20px;box-shadow:0 8px 40px rgba(0,0,0,.10);max-width:480px;width:100%;overflow:hidden}
.ok-header{background:linear-gradient(135deg,#065f46,#047857);padding:2.5rem 2rem;text-align:center;color:#fff}
.ok-check{font-size:3.5rem;line-height:1;margin-bottom:.8rem}
.ok-header h1{font-size:1.7rem;font-weight:900;letter-spacing:-.4px;margin-bottom:.5rem}
.ok-header p{opacity:.88;font-size:.92rem;line-height:1.6;max-width:300px;margin:0 auto}
.ok-body{padding:1.8rem 2rem}
.ok-detail{margin-bottom:1.2rem}
.ok-row{display:flex;justify-content:space-between;align-items:center;padding:.65rem 0;border-bottom:1px solid #e2e8f0;font-size:.9rem}
.ok-row:last-child{border-bottom:none}
.ok-row span{color:#718096}
.ok-row strong{color:#1a202c;text-align:right}
.ok-prezzo{color:#d97706!important;font-size:1.1rem}
.ok-stato{padding:.75rem 1.2rem;border-radius:10px;font-weight:700;font-size:.9rem;text-align:center;margin-bottom:1.2rem}
.ok-note{background:#fef3c7;border:1px solid #fbbf24;border-radius:10px;padding:1rem;font-size:.82rem;color:#92400e;margin-bottom:1.2rem;line-height:1.6}
.ok-tel{display:flex;align-items:center;justify-content:center;gap:.5rem;background:#0f2244;color:#fff;text-decoration:none;padding:1rem;border-radius:12px;font-weight:700;font-size:1rem;margin-bottom:.7rem;transition:background .15s}
.ok-tel:hover{background:#1e3a5f}
.ok-back{display:block;text-align:center;color:#718096;font-size:.85rem;text-decoration:none;padding:.5rem}
.ok-back:hover{color:#1a202c}
</style>
</head><body>
<div class="card">
  <div class="ok-header">
    <div class="ok-check">🔐</div>
    <h1>Intervento confermato!</h1>
    <p>La carta è stata pre-autorizzata. Il tecnico è in arrivo — verrai contattato entro pochi minuti.</p>
  </div>
  <div class="ok-body">
    ${richiestaHtml || `<div class="ok-note">🔐 Carta pre-autorizzata. Ti contatteremo a breve per confermare il tecnico.</div>`}
    <div class="ok-note" style="background:#fef9c3;border-color:#fde68a;color:#713f12">🔐 <strong>Nessun addebito immediato.</strong> L'importo è solo pre-autorizzato sulla tua carta. Se paghi in contanti sul posto, la pre-autorizzazione verrà annullata e i fondi sbloccati entro qualche giorno lavorativo.</div>
    <a class="ok-tel" href="tel:+393405707813">📞 Hai dubbi? Chiamaci al 340 570 7813</a>
    <a class="ok-back" href="/">← Torna al sito</a>
  </div>
</div>
</body></html>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(html);
});

const ADMIN_NAV = `<header>
  <h1>&#9889; prontointerventomi.it — Admin</h1>
  <nav><a href="/admin">Richieste</a><a href="/admin/tecnici">Tecnici</a><a href="/">&#8592; Sito pubblico</a></nav>
</header>`;

const ADMIN_CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#f0f4f8;color:#1a202c}
header{background:linear-gradient(135deg,#c0392b,#e74c3c);color:white;padding:1.2rem 2rem;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:1rem}
header h1{font-size:1.3rem;font-weight:800}
header nav{display:flex;gap:.5rem;flex-wrap:wrap}
header nav a{color:white;font-size:.85rem;text-decoration:none;border:1px solid rgba(255,255,255,.4);border-radius:2rem;padding:.35rem 1rem;background:rgba(255,255,255,.08)}
header nav a:hover{background:rgba(255,255,255,.2)}
.stats{display:flex;gap:1rem;padding:1.5rem 2rem;flex-wrap:wrap}
.stat{background:white;border-radius:.75rem;padding:1.1rem 1.4rem;box-shadow:0 2px 10px rgba(0,0,0,.06);flex:1;min-width:140px}
.stat .num{font-size:1.9rem;font-weight:800;color:#c0392b}
.stat .lbl{font-size:.75rem;color:#718096;margin-top:.2rem;text-transform:uppercase;letter-spacing:.5px}
.container{padding:0 2rem 3rem;display:flex;flex-direction:column;gap:1.5rem}
.card{background:white;border-radius:1rem;box-shadow:0 2px 10px rgba(0,0,0,.06);overflow:hidden}
.card-header{padding:1rem 1.5rem;border-bottom:1px solid #e2e8f0;font-weight:700;font-size:.95rem;color:#4a5568;display:flex;justify-content:space-between;align-items:center}
table{width:100%;border-collapse:collapse;font-size:.88rem}
th{background:#f7fafc;padding:.7rem 1rem;text-align:left;font-size:.72rem;text-transform:uppercase;letter-spacing:.5px;color:#718096;border-bottom:1px solid #e2e8f0}
td{padding:.8rem 1rem;border-bottom:1px solid #f0f4f8;vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:#fffaf0}
td a{color:#2b6cb0;text-decoration:none}
.badge{display:inline-block;padding:.2rem .6rem;border-radius:2rem;font-size:.75rem;font-weight:600}
.badge-impianti_elettrici{background:#fefce8;color:#854d0e}
.badge-allarmi{background:#fff1f2;color:#9f1239}
.badge-automazione_cancelli{background:#f4f4f5;color:#3f3f46}
.badge-citofoni{background:#eff6ff;color:#1d4ed8}
.badge-antenne{background:#f0fdf4;color:#166534}
.empty{text-align:center;padding:3rem;color:#a0aec0;font-size:.95rem}
form.inline{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;padding:1.2rem 1.5rem;background:#f7fafc;border-bottom:1px solid #e2e8f0}
form.inline input,form.inline select{padding:.55rem .8rem;border:1.5px solid #e2e8f0;border-radius:.45rem;font-size:.85rem;background:white;flex:1;min-width:120px}
form.inline button{padding:.55rem 1.2rem;background:#c0392b;color:white;border:none;border-radius:.45rem;font-size:.85rem;font-weight:600;cursor:pointer}
form.inline button:hover{background:#a93226}
.danger{background:#fee2e2!important;color:#991b1b!important;border:none;padding:.3rem .7rem;border-radius:.35rem;font-size:.75rem;font-weight:600;cursor:pointer}
.danger:hover{background:#fecaca!important}
.assegna-form{display:flex;gap:.3rem;align-items:center}
.assegna-form select{padding:.3rem .5rem;font-size:.78rem;border:1px solid #e2e8f0;border-radius:.3rem}
.assegna-form button{padding:.3rem .7rem;font-size:.75rem;background:#2b6cb0;color:white;border:none;border-radius:.3rem;cursor:pointer;font-weight:600}
.assegna-form button:hover{background:#2c5282}
.note{padding:.7rem 1.5rem;background:#fffbeb;color:#92400e;font-size:.78rem;border-bottom:1px solid #fde68a}
@media(max-width:700px){.container{padding:0 1rem 2rem}.stats{padding:1rem}table{font-size:.78rem}th,td{padding:.5rem .4rem}}
.avail-banner{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:1rem;padding:1rem 2rem;margin-bottom:0}
.avail-banner.on{background:#d1fae5;border-bottom:3px solid #10b981}
.avail-banner.off{background:#fee2e2;border-bottom:3px solid #ef4444}
.avail-banner .avail-info{display:flex;align-items:center;gap:.75rem}
.avail-banner .avail-dot{width:14px;height:14px;border-radius:50%;flex-shrink:0}
.avail-banner.on .avail-dot{background:#10b981;box-shadow:0 0 0 4px rgba(16,185,129,.25)}
.avail-banner.off .avail-dot{background:#ef4444;box-shadow:0 0 0 4px rgba(239,68,68,.25)}
.avail-banner .avail-text strong{display:block;font-size:1rem;color:#1a202c}
.avail-banner .avail-text span{font-size:.8rem;color:#4a5568}
.avail-toggle-btn{padding:.6rem 1.4rem;border:none;border-radius:.5rem;font-size:.9rem;font-weight:700;cursor:pointer;font-family:inherit;transition:background .15s}
.avail-banner.on .avail-toggle-btn{background:#ef4444;color:white}
.avail-banner.on .avail-toggle-btn:hover{background:#dc2626}
.avail-banner.off .avail-toggle-btn{background:#10b981;color:white}
.avail-banner.off .avail-toggle-btn:hover{background:#059669}
`;

app.use((req, res, next) => {
  if (req.path === "/admin" || req.path.startsWith("/admin/")) return adminAuth(req, res, next);
  next();
});

app.post("/admin/richieste/:id/cattura", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.redirect("/admin");
  const result = await catturaPagamento(id);
  if (!result.ok) logger.error({ id, errore: result.errore }, "Cattura fallita");
  res.redirect("/admin");
});

app.post("/admin/richieste/:id/annulla-pagamento", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.redirect("/admin");
  const result = await annullaPagamento(id);
  if (!result.ok) logger.error({ id, errore: result.errore }, "Annullamento fallito");
  res.redirect("/admin");
});

app.post("/admin/disponibilita", async (_req, res) => {
  tecnicoDisponibile = !tecnicoDisponibile;
  logger.info({ tecnicoDisponibile }, "Disponibilità tecnici aggiornata");
  await salvaDisponibilita(tecnicoDisponibile).catch(err => logger.error({ err }, "Errore salvataggio disponibilità"));
  res.redirect("/admin");
});

app.get("/admin", async (_req, res) => {
  const richieste = await db.select().from(richiesteTable).orderBy(desc(richiesteTable.createdAt));
  const tecnici = await db.select().from(tecniciTable).where(eq(tecniciTable.attivo, true));

  const tecniciById = new Map(tecnici.map(t => [t.id, t]));

  const rows = richieste.map((r) => {
    const data = r.createdAt.toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" });
    const fascia = FASCIA_LABEL[r.fasciaOraria] ?? r.fasciaOraria;
    const stato = STATO_LABEL[r.stato] ?? STATO_LABEL.in_attesa;
    const tecnicoAss = r.tecnicoId ? tecniciById.get(r.tecnicoId) : null;

    // Tecnici candidati per assegnazione
    const candidati = tecnici.filter(t =>
      t.categorie.includes(r.servizio) &&
      (!r.cap || t.capServiti.includes(r.cap))
    );

    const assegnaCell = r.tecnicoId && tecnicoAss
      ? `<div><strong>${esc(tecnicoAss.nome)}</strong><br><small><a href="tel:${esc(tecnicoAss.telefono)}">${esc(tecnicoAss.telefono)}</a></small></div>`
      : candidati.length === 0
        ? `<small style="color:#a0aec0">Nessun tecnico disponibile</small>`
        : `<form class="assegna-form" method="post" action="/admin/richieste/${r.id}/assegna">
            <select name="tecnicoId" required>
              <option value="">— scegli —</option>
              ${candidati.map(t => `<option value="${t.id}">${esc(t.nome)} (★${t.rating})</option>`).join("")}
            </select>
            <button type="submit">Assegna</button>
          </form>`;

    // Pulsanti cattura / annulla per richieste con carta autorizzata
    const stripeActionsCell = r.stato === "autorizzata" && r.stripePaymentIntentId
      ? `<div style="display:flex;flex-direction:column;gap:.3rem">
          <form method="post" action="/admin/richieste/${r.id}/cattura" onsubmit="return confirm('Addebitare ${eur(r.prezzoUscitaCents)} sulla carta del cliente?')">
            <button type="submit" style="width:100%;padding:.3rem .7rem;font-size:.75rem;background:#16a34a;color:white;border:none;border-radius:.35rem;font-weight:600;cursor:pointer">💳 Cattura pagamento</button>
          </form>
          <form method="post" action="/admin/richieste/${r.id}/annulla-pagamento" onsubmit="return confirm('Annullare la pre-autorizzazione e sbloccare i fondi?')">
            <button type="submit" style="width:100%;padding:.3rem .7rem;font-size:.75rem;background:#d97706;color:white;border:none;border-radius:.35rem;font-weight:600;cursor:pointer">💵 Pagato in contanti</button>
          </form>
        </div>`
      : `<small style="color:#a0aec0">—</small>`;

    const servizioClass = SERVIZI_VALIDI.has(r.servizio) ? r.servizio : "impianti_elettrici";
    return `<tr>
      <td>#${r.id}</td>
      <td><strong>${esc(r.nome)}</strong><br><small><a href="tel:${esc(r.telefono)}">${esc(r.telefono)}</a></small></td>
      <td>${esc(r.indirizzo)}<br><small style="color:#718096">${esc(r.cap)}</small></td>
      <td><span class="badge badge-${servizioClass}">${esc(SERVIZIO_LABEL[r.servizio] ?? r.servizio)}</span><br><small style="color:#718096">${esc(fascia)}</small></td>
      <td><strong>${eur(r.prezzoUscitaCents)}</strong></td>
      <td><span class="badge" style="background:${stato.bg};color:${stato.col}">${stato.txt}</span></td>
      <td>${assegnaCell}</td>
      <td>${stripeActionsCell}</td>
      <td><small>${data}</small></td>
    </tr>`;
  }).join("");

  const inAttesa = richieste.filter(r => r.stato === "in_attesa").length;
  const assegnate = richieste.filter(r => r.stato !== "in_attesa" && r.stato !== "annullata").length;
  const fatturato = richieste.filter(r => r.stato === "completata").reduce((s, r) => s + r.prezzoUscitaCents, 0);
  const tuoMargine = Math.round(fatturato * FEE_PIATTAFORMA);

  const availClass = tecnicoDisponibile ? "on" : "off";
  const availLabel = tecnicoDisponibile ? "Servizio ATTIVO — I clienti possono prenotare" : "Servizio SOSPESO — Le prenotazioni sono bloccate";
  const availBtn = tecnicoDisponibile ? "🔴 Disattiva servizio" : "🟢 Attiva servizio";

  const html = `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Admin — Richieste</title><style>${ADMIN_CSS}</style></head><body>
${ADMIN_NAV}
<div class="avail-banner ${availClass}">
  <div class="avail-info">
    <div class="avail-dot"></div>
    <div class="avail-text">
      <strong>${availLabel}</strong>
      <span>Controlla se i tecnici sono disponibili a ricevere nuove richieste</span>
    </div>
  </div>
  <form method="post" action="/admin/disponibilita" onsubmit="return confirm('${tecnicoDisponibile ? "Vuoi SOSPENDERE il servizio? I clienti non potranno prenotare." : "Vuoi ATTIVARE il servizio? I clienti potranno prenotare."}')">
    <button type="submit" class="avail-toggle-btn">${availBtn}</button>
  </form>
</div>
<div class="stats">
  <div class="stat"><div class="num">${richieste.length}</div><div class="lbl">Richieste totali</div></div>
  <div class="stat"><div class="num">${inAttesa}</div><div class="lbl">In attesa</div></div>
  <div class="stat"><div class="num">${assegnate}</div><div class="lbl">In lavorazione</div></div>
  <div class="stat"><div class="num">${tecnici.length}</div><div class="lbl">Tecnici attivi</div></div>
  <div class="stat"><div class="num">${eur(tuoMargine)}</div><div class="lbl">Tuo margine (35%)</div></div>
</div>
<div class="container"><div class="card">
  <div class="card-header">Richieste ricevute</div>
  ${richieste.length === 0
    ? `<div class="empty">Nessuna richiesta ancora.</div>`
    : `<div style="overflow-x:auto"><table>
        <thead><tr><th>#</th><th>Cliente</th><th>Indirizzo / CAP</th><th>Servizio / Fascia</th><th>Prezzo</th><th>Stato</th><th>Tecnico assegnato</th><th>Azioni pagamento</th><th>Data</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`}
</div></div></body></html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.send(html);
});

app.get("/admin/tecnici", async (_req, res) => {
  const tecnici = await db.select().from(tecniciTable).orderBy(desc(tecniciTable.createdAt));

  const rows = tecnici.map(t => `<tr>
    <td>#${t.id}</td>
    <td><strong>${esc(t.nome)}</strong><br><small style="color:${t.attivo ? "#276749" : "#c0392b"}">${t.attivo ? "● Attivo" : "○ Disattivato"}</small></td>
    <td><a href="tel:${esc(t.telefono)}">${esc(t.telefono)}</a>${t.email ? `<br><small>${esc(t.email)}</small>` : ""}</td>
    <td>${t.categorie.map(c => SERVIZI_VALIDI.has(c) ? `<span class="badge badge-${c}" style="margin-right:.2rem">${esc(SERVIZIO_LABEL[c])}</span>` : `<span class="badge" style="margin-right:.2rem">${esc(c)}</span>`).join("")}</td>
    <td><small>${esc(t.capServiti.join(", "))}</small></td>
    <td>★ ${t.rating}</td>
    <td><code style="background:#f7fafc;padding:.2rem .4rem;border-radius:.25rem;font-size:.9rem">${esc(t.pin || "—")}</code><br><small style="color:#718096">App login</small></td>
    <td style="white-space:nowrap">
      <form method="post" action="/admin/tecnici/${t.id}/toggle" style="display:inline">
        <button type="submit" class="${t.attivo ? "danger" : ""}" style="${t.attivo ? "" : "background:#d1fae5;color:#065f46;border:none;padding:.3rem .7rem;border-radius:.35rem;font-size:.75rem;font-weight:600;cursor:pointer"}">${t.attivo ? "Disattiva" : "Attiva"}</button>
      </form>
      <button type="button" class="danger" style="background:#2b6cb0;color:white;margin-left:.3rem" onclick="editTecnico(${t.id},'${esc(t.nome).replace(/'/g, "\\'")}','${esc(t.telefono).replace(/'/g, "\\'")}','${esc(t.email ?? "").replace(/'/g, "\\'")}','${esc(t.categorie.join(",")).replace(/'/g, "\\'")}','${esc(t.capServiti.join(",")).replace(/'/g, "\\'")}',${t.rating})">Modifica</button>
      <form method="post" action="/admin/tecnici/${t.id}/elimina" style="display:inline;margin-left:.3rem" onsubmit="return confirm('Eliminare ${esc(t.nome).replace(/'/g, "")}?')">
        <button type="submit" class="danger">Elimina</button>
      </form>
    </td>
  </tr>`).join("");

  const html = `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Admin — Tecnici</title><style>${ADMIN_CSS}
#edit-modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:100;align-items:center;justify-content:center;padding:1rem}
#edit-modal.open{display:flex}
.modal-box{background:#fff;border-radius:1rem;padding:1.5rem;width:100%;max-width:520px;box-shadow:0 20px 60px rgba(0,0,0,.3)}
.modal-box h2{font-size:1.1rem;font-weight:700;margin-bottom:1rem;color:#c0392b}
.modal-box input{width:100%;padding:.55rem .8rem;border:1.5px solid #e2e8f0;border-radius:.45rem;font-size:.88rem;background:white;margin-bottom:.5rem}
.modal-box input:focus{outline:none;border-color:#c0392b}
.modal-actions{display:flex;gap:.5rem;margin-top:.5rem}
.modal-actions button{flex:1;padding:.65rem;border:none;border-radius:.45rem;font-size:.9rem;font-weight:600;cursor:pointer}
.btn-save{background:#c0392b;color:white}.btn-cancel{background:#f7fafc;color:#4a5568;border:1.5px solid #e2e8f0!important}
</style></head><body>
${ADMIN_NAV}
<div class="stats">
  <div class="stat"><div class="num">${tecnici.length}</div><div class="lbl">Tecnici totali</div></div>
  <div class="stat"><div class="num">${tecnici.filter(t => t.attivo).length}</div><div class="lbl">Attivi</div></div>
</div>
<div class="container"><div class="card">
  <div class="card-header">Aggiungi nuovo tecnico</div>
  <div class="note">Categorie: separare con virgola — Valori validi: <code>impianti_elettrici, allarmi, automazione_cancelli, citofoni, antenne</code>. CAP: separare con virgola (es: <code>20121,20122,20123</code>).</div>
  <form class="inline" method="post" action="/admin/tecnici">
    <input name="nome" placeholder="Nome e cognome" required/>
    <input name="telefono" placeholder="Telefono" required/>
    <input name="email" placeholder="Email (facoltativo)"/>
    <input name="categorie" placeholder="es: impianti_elettrici,allarmi" required/>
    <input name="capServiti" placeholder="CAP serviti (es: 20121,20122)" required/>
    <input name="rating" type="number" min="0" max="100" placeholder="Rating 0-100" value="50"/>
    <button type="submit">+ Aggiungi tecnico</button>
  </form>
  ${tecnici.length === 0
    ? `<div class="empty">Nessun tecnico registrato. Aggiungi il primo qui sopra.</div>`
    : `<div style="overflow-x:auto"><table>
        <thead><tr><th>#</th><th>Nome / Stato</th><th>Contatti</th><th>Categorie</th><th>CAP serviti</th><th>Rating</th><th>PIN</th><th>Azioni</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`}
</div></div>

<div id="edit-modal">
  <div class="modal-box">
    <h2>✏️ Modifica tecnico</h2>
    <form id="edit-form" method="post">
      <input name="nome" id="e-nome" placeholder="Nome e cognome" required/>
      <input name="telefono" id="e-telefono" placeholder="Telefono" required/>
      <input name="email" id="e-email" placeholder="Email (facoltativo)"/>
      <input name="categorie" id="e-categorie" placeholder="es: impianti_elettrici,allarmi" required/>
      <input name="capServiti" id="e-cap" placeholder="CAP serviti (es: 20121,20122)" required/>
      <input name="rating" id="e-rating" type="number" min="0" max="100" placeholder="Rating 0-100"/>
      <div class="modal-actions">
        <button type="button" class="btn-cancel" onclick="closeEdit()">Annulla</button>
        <button type="submit" class="btn-save">Salva modifiche</button>
      </div>
    </form>
  </div>
</div>
<script>
function editTecnico(id,nome,telefono,email,categorie,cap,rating){
  document.getElementById('e-nome').value=nome;
  document.getElementById('e-telefono').value=telefono;
  document.getElementById('e-email').value=email;
  document.getElementById('e-categorie').value=categorie;
  document.getElementById('e-cap').value=cap;
  document.getElementById('e-rating').value=rating;
  document.getElementById('edit-form').action='/admin/tecnici/'+id+'/modifica';
  document.getElementById('edit-modal').classList.add('open');
}
function closeEdit(){document.getElementById('edit-modal').classList.remove('open');}
document.getElementById('edit-modal').addEventListener('click',function(e){if(e.target===this)closeEdit();});
</script>
</body></html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.send(html);
});

app.post("/admin/tecnici", async (req, res) => {
  const body = req.body as Record<string, string>;
  const nome = (body.nome ?? "").trim().slice(0, 100);
  const telefono = (body.telefono ?? "").trim().slice(0, 30);
  const email = (body.email ?? "").trim().slice(0, 100) || null;
  const cats = (body.categorie ?? "").split(",").map(s => s.trim().toLowerCase()).filter(c => SERVIZI_VALIDI.has(c));
  const caps = (body.capServiti ?? "").split(",").map(s => s.trim()).filter(s => CAP_REGEX.test(s));
  const ratingNum = parseInt(body.rating ?? "50", 10);
  const rating = Number.isFinite(ratingNum) ? Math.min(100, Math.max(0, ratingNum)) : 50;
  const pin = String(Math.floor(1000 + Math.random() * 9000));

  if (!nome || !telefono || cats.length === 0 || caps.length === 0) {
    return res.status(400).send("Dati non validi: servono nome, telefono, almeno una categoria valida e almeno un CAP a 5 cifre.");
  }
  await db.insert(tecniciTable).values({ nome, telefono, email, categorie: cats, capServiti: caps, rating, pin });
  res.redirect("/admin/tecnici");
});

// ====== API Mobile App Tecnico ======

app.post("/api/tecnico/login", async (req, res) => {
  const { telefono, pin } = (req.body ?? {}) as { telefono?: string; pin?: string };
  if (!telefono || !pin) return res.status(400).json({ errore: "Telefono e PIN obbligatori" });
  const tel = String(telefono).trim();
  const p = String(pin).trim();
  const [t] = await db.select().from(tecniciTable).where(eq(tecniciTable.telefono, tel));
  if (!t || !t.attivo || t.pin !== p) return res.status(401).json({ errore: "Credenziali non valide" });
  res.json({
    successo: true,
    tecnico: {
      id: t.id, nome: t.nome, telefono: t.telefono, email: t.email,
      categorie: t.categorie, capServiti: t.capServiti, rating: t.rating,
      stripeOnboardingCompleto: Boolean(t.stripeAccountId),
    },
  });
});

app.get("/api/tecnico/disponibilita", async (req, res) => {
  const auth = await authTecnico(req, res);
  if (!auth) return;
  res.json({ disponibile: tecnicoDisponibile });
});

app.post("/api/tecnico/disponibilita", async (req, res) => {
  const auth = await authTecnico(req, res);
  if (!auth) return;
  const { disponibile } = (req.body ?? {}) as { disponibile?: boolean };
  if (typeof disponibile !== "boolean") return res.status(400).json({ errore: "Campo disponibile (boolean) obbligatorio" });
  tecnicoDisponibile = disponibile;
  await salvaDisponibilita(disponibile).catch(err => logger.error({ err }, "Errore salvataggio disponibilità da app tecnico"));
  logger.info({ tecnicoId: auth.id, disponibile }, "Disponibilità aggiornata da app tecnico");
  res.json({ successo: true, disponibile });
});

app.post("/api/tecnico/expo-token", async (req, res) => {
  const auth = await authTecnico(req, res);
  if (!auth) return;
  const { token } = (req.body ?? {}) as { token?: string };
  if (!token || typeof token !== "string") return res.status(400).json({ errore: "Token mancante" });
  await db.update(tecniciTable).set({ expoToken: token }).where(eq(tecniciTable.id, auth.id));
  res.json({ successo: true });
});

async function authTecnico(req: express.Request, res: express.Response): Promise<{ id: number; pin: string } | null> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) { res.status(401).json({ errore: "Non autenticato" }); return null; }
  const token = auth.slice(7);
  const [idStr, pin] = Buffer.from(token, "base64").toString("utf8").split(":");
  const id = parseInt(idStr, 10);
  if (!Number.isFinite(id) || !pin) { res.status(401).json({ errore: "Token non valido" }); return null; }
  const [t] = await db.select().from(tecniciTable).where(eq(tecniciTable.id, id));
  if (!t || !t.attivo || t.pin !== pin) { res.status(401).json({ errore: "Sessione scaduta" }); return null; }
  return { id, pin };
}

app.get("/api/tecnico/richieste", async (req, res) => {
  const auth = await authTecnico(req, res);
  if (!auth) return;
  const richieste = await db.select().from(richiesteTable)
    .where(eq(richiesteTable.tecnicoId, auth.id))
    .orderBy(desc(richiesteTable.createdAt));
  res.json({
    richieste: richieste.map(r => ({
      id: r.id, nome: r.nome, telefono: r.telefono, indirizzo: r.indirizzo, cap: r.cap,
      servizio: r.servizio, servizioLabel: SERVIZIO_LABEL[r.servizio] || r.servizio,
      fasciaOraria: r.fasciaOraria, fasciaLabel: FASCIA_LABEL[r.fasciaOraria] || r.fasciaOraria,
      prezzoUscitaCents: r.prezzoUscitaCents, stato: r.stato,
      statoLabel: STATO_LABEL[r.stato]?.txt || r.stato,
      createdAt: r.createdAt,
    })),
  });
});

app.post("/api/tecnico/richiesta/:id/azione", async (req, res) => {
  const auth = await authTecnico(req, res);
  if (!auth) return;
  const id = parseInt(req.params.id, 10);
  const { azione } = (req.body ?? {}) as { azione?: string };
  if (!Number.isFinite(id) || !azione) return res.status(400).json({ errore: "Parametri mancanti" });

  const [r] = await db.select().from(richiesteTable).where(eq(richiesteTable.id, id));
  if (!r) return res.status(404).json({ errore: "Richiesta non trovata" });
  if (r.tecnicoId !== auth.id) return res.status(403).json({ errore: "Richiesta non assegnata a te" });

  const trans: Record<string, { from: string[]; to: string }> = {
    accetta:   { from: ["assegnata"],            to: "accettata"  },
    rifiuta:   { from: ["assegnata"],            to: "in_attesa"  },
    completa:  { from: ["accettata", "assegnata"], to: "completata" },
  };
  const t = trans[azione];
  if (!t) return res.status(400).json({ errore: "Azione non valida" });
  if (!t.from.includes(r.stato)) return res.status(400).json({ errore: `Non puoi ${azione} una richiesta in stato ${r.stato}` });

  const updates: Partial<typeof richiesteTable.$inferInsert> = { stato: t.to };
  if (azione === "rifiuta") updates.tecnicoId = null;
  await db.update(richiesteTable).set(updates).where(eq(richiesteTable.id, id));

  const [tecnico] = await db.select().from(tecniciTable).where(eq(tecniciTable.id, auth.id));

  if (azione === "accetta" && tecnico) {
    notificaClienteTecnicoAccettato(r.telefono, tecnico.nome, tecnico.telefono).catch(() => {});
    notificaAdmin({
      titolo: "✅ Tecnico ha accettato",
      righe: [
        `🔧 ${tecnico.nome} (${tecnico.telefono})`,
        `👤 Cliente: ${r.nome} — ${r.telefono}`,
        `📍 ${r.indirizzo} (${r.cap})`,
        `${SERVIZIO_LABEL[r.servizio] ?? r.servizio}`,
      ],
    }).catch(() => {});
  } else if (azione === "rifiuta" && tecnico) {
    notificaAdmin({
      titolo: "❌ Tecnico ha rifiutato — RIASSEGNARE",
      righe: [
        `🔧 ${tecnico.nome} (${tecnico.telefono})`,
        `👤 Cliente: ${r.nome} — ${r.telefono}`,
        `📍 ${r.indirizzo} (${r.cap})`,
        `${SERVIZIO_LABEL[r.servizio] ?? r.servizio}`,
      ],
    }).catch(() => {});
  } else if (azione === "completa" && tecnico) {
    notificaAdmin({
      titolo: "🏁 Intervento completato",
      righe: [
        `🔧 ${tecnico.nome}`,
        `👤 Cliente: ${r.nome} — ${r.telefono}`,
        `📍 ${r.indirizzo} (${r.cap})`,
        `${SERVIZIO_LABEL[r.servizio] ?? r.servizio}`,
        `💶 Da incassare: € ${(r.prezzoUscitaCents / 100).toFixed(2)}`,
      ],
    }).catch(() => {});
    // Richiesta recensione al cliente (via Telegram admin + email se disponibile)
    inviaRichiestaRecensione({
      nome: r.nome,
      telefono: r.telefono,
      servizio: SERVIZIO_LABEL[r.servizio] ?? r.servizio,
      richiestaId: r.id,
    }).catch(() => {});
  }

  res.json({ successo: true, nuovoStato: t.to });
});

app.post("/admin/tecnici/:id/elimina", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.redirect("/admin/tecnici");
  await db.delete(tecniciTable).where(eq(tecniciTable.id, id));
  res.redirect("/admin/tecnici");
});

app.post("/admin/tecnici/:id/toggle", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.redirect("/admin/tecnici");
  const [t] = await db.select().from(tecniciTable).where(eq(tecniciTable.id, id));
  if (!t) return res.redirect("/admin/tecnici");
  await db.update(tecniciTable).set({ attivo: !t.attivo }).where(eq(tecniciTable.id, id));
  res.redirect("/admin/tecnici");
});

app.post("/admin/tecnici/:id/modifica", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.redirect("/admin/tecnici");
  const body = req.body as Record<string, string>;
  const nome = (body.nome ?? "").trim().slice(0, 100);
  const telefono = (body.telefono ?? "").trim().slice(0, 30);
  const email = (body.email ?? "").trim().slice(0, 100) || null;
  const cats = (body.categorie ?? "").split(",").map(s => s.trim().toLowerCase()).filter(c => SERVIZI_VALIDI.has(c));
  const caps = (body.capServiti ?? "").split(",").map(s => s.trim()).filter(s => CAP_REGEX.test(s));
  const ratingNum = parseInt(body.rating ?? "50", 10);
  const rating = Number.isFinite(ratingNum) ? Math.min(100, Math.max(0, ratingNum)) : 50;
  if (!nome || !telefono || cats.length === 0 || caps.length === 0) {
    return res.status(400).send("Dati non validi.");
  }
  await db.update(tecniciTable).set({ nome, telefono, email, categorie: cats, capServiti: caps, rating }).where(eq(tecniciTable.id, id));
  res.redirect("/admin/tecnici");
});

app.post("/admin/richieste/:id/assegna", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const tecnicoId = parseInt((req.body as { tecnicoId: string }).tecnicoId, 10);
  if (!Number.isFinite(id) || !Number.isFinite(tecnicoId)) return res.redirect("/admin");

  const [richiesta] = await db.select().from(richiesteTable).where(eq(richiesteTable.id, id));
  const [tecnico] = await db.select().from(tecniciTable).where(eq(tecniciTable.id, tecnicoId));

  if (!richiesta || !tecnico) return res.status(400).send("Richiesta o tecnico non trovati.");
  if (!tecnico.attivo) return res.status(400).send("Tecnico non attivo.");
  if (!tecnico.categorie.includes(richiesta.servizio)) return res.status(400).send("Tecnico non abilitato per questa categoria.");
  if (richiesta.cap && !tecnico.capServiti.includes(richiesta.cap)) return res.status(400).send("Tecnico non copre questo CAP.");
  if (richiesta.stato !== "in_attesa") return res.status(400).send("Richiesta già assegnata o chiusa.");

  await db.update(richiesteTable).set({ tecnicoId, stato: "assegnata" }).where(eq(richiesteTable.id, id));
  notificaTecnicoNuovaRichiesta(tecnico.telefono, richiesta.servizio, richiesta.indirizzo).catch(() => {});
  sendPushNotification(
    tecnico.expoToken,
    "🔧 Nuovo intervento assegnato",
    `${SERVIZIO_LABEL[richiesta.servizio] ?? richiesta.servizio} — ${richiesta.indirizzo}`,
    { richiestaId: richiesta.id },
  ).catch(() => {});
  res.redirect("/admin");
});

registerClienteRoutes(app);
registerStripeRoutes(app);

logger.info({ stripeEnabled, notifiche: notificheConfigurate }, "Integrazioni esterne");

app.use("/api", router);

export { caricaDisponibilita };
export default app;
