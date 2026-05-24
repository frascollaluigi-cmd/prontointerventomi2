import type { Express, Request, Response, NextFunction } from "express";
import { db, richiesteTable, tecniciTable } from "@workspace/db";
import { eq, desc, and, sql } from "drizzle-orm";

const SERVIZIO_LABEL: Record<string, string> = {
  impianti_elettrici: "Impianti elettrici",
  allarmi: "Allarmi",
  automazione_cancelli: "Automazione cancelli",
  citofoni: "Citofoni",
  antenne: "Antenne",
};
const SERVIZIO_ICON: Record<string, string> = {
  impianti_elettrici: "⚡",
  allarmi: "🔔",
  automazione_cancelli: "🚪",
  citofoni: "📞",
  antenne: "📡",
};
const FASCIA_LABEL: Record<string, string> = {
  standard: "Standard (entro 4 ore)",
  urgente: "Urgente (entro 1,5 ore)",
  notte_festivo: "Dopo le 17 / Festivi",
};
const STATO_LABEL: Record<string, { txt: string; bg: string; col: string }> = {
  in_attesa:      { txt: "In attesa di un tecnico",     bg: "#fef3c7", col: "#92400e" },
  assegnata:      { txt: "Tecnico assegnato",            bg: "#dbeafe", col: "#1e40af" },
  accettata:      { txt: "Tecnico in arrivo",            bg: "#d1fae5", col: "#065f46" },
  completata:     { txt: "Intervento completato",        bg: "#e0e7ff", col: "#3730a3" },
  autorizzata:    { txt: "🔐 Carta autorizzata",         bg: "#fef9c3", col: "#713f12" },
  pagata:         { txt: "✅ Pagato con carta",           bg: "#dcfce7", col: "#166534" },
  auth_annullata: { txt: "💵 Pagato in contanti",        bg: "#f0fdf4", col: "#166534" },
  annullata:      { txt: "Annullata",                    bg: "#fee2e2", col: "#991b1b" },
};
const LISTINO: Record<string, Record<string, number>> = {
  impianti_elettrici:   { standard: 7000, urgente: 12000, notte_festivo: 20000 },
  allarmi:              { standard: 7000, urgente: 12000, notte_festivo: 20000 },
  automazione_cancelli: { standard: 7000, urgente: 12000, notte_festivo: 20000 },
  citofoni:             { standard: 7000, urgente: 12000, notte_festivo: 20000 },
  antenne:              { standard: 7000, urgente: 12000, notte_festivo: 20000 },
};
const SERVIZI_VALIDI = new Set(Object.keys(SERVIZIO_LABEL));
const FASCE_VALIDE = new Set(Object.keys(FASCIA_LABEL));
const CAP_REGEX = /^[0-9]{5}$/;

function calcolaPrezzo(servizio: string, fascia: string): number {
  return LISTINO[servizio]?.[fascia] ?? 5900;
}

function authCliente(req: Request): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  try {
    const tel = Buffer.from(token, "base64").toString("utf8");
    if (!/^\+?[0-9\s]{6,20}$/.test(tel)) return null;
    return tel.trim();
  } catch { return null; }
}

function richiestaToJson(r: typeof richiesteTable.$inferSelect, tecnico?: typeof tecniciTable.$inferSelect | null) {
  const stato = STATO_LABEL[r.stato] ?? { txt: r.stato, bg: "#eee", col: "#333" };
  return {
    id: r.id,
    nome: r.nome,
    telefono: r.telefono,
    indirizzo: r.indirizzo,
    cap: r.cap,
    servizio: r.servizio,
    servizioLabel: SERVIZIO_LABEL[r.servizio] ?? r.servizio,
    servizioIcon: SERVIZIO_ICON[r.servizio] ?? "🔧",
    fasciaOraria: r.fasciaOraria,
    fasciaLabel: FASCIA_LABEL[r.fasciaOraria] ?? r.fasciaOraria,
    prezzoUscitaCents: r.prezzoUscitaCents,
    stato: r.stato,
    statoLabel: stato.txt,
    statoBg: stato.bg,
    statoCol: stato.col,
    createdAt: r.createdAt,
    tecnico: tecnico ? {
      id: tecnico.id, nome: tecnico.nome, telefono: tecnico.telefono, rating: tecnico.rating,
    } : null,
  };
}

export function registerClienteRoutes(app: Express): void {
  // ── API ───────────────────────────────────────────
  app.post("/api/cliente/login", (req: Request, res: Response) => {
    const { telefono, nome } = (req.body ?? {}) as { telefono?: string; nome?: string };
    const tel = String(telefono ?? "").trim();
    const nm = String(nome ?? "").trim().slice(0, 100);
    if (!/^\+?[0-9\s]{6,20}$/.test(tel)) return res.status(400).json({ errore: "Numero di telefono non valido" });
    if (!nm) return res.status(400).json({ errore: "Nome obbligatorio" });
    const token = Buffer.from(tel).toString("base64");
    res.json({ successo: true, token, cliente: { telefono: tel, nome: nm } });
  });

  app.get("/api/cliente/richieste", async (req: Request, res: Response) => {
    const tel = authCliente(req);
    if (!tel) return res.status(401).json({ errore: "Non autenticato" });
    const rows = await db.select().from(richiesteTable)
      .where(eq(richiesteTable.telefono, tel))
      .orderBy(desc(richiesteTable.createdAt));
    const tecIds = rows.map(r => r.tecnicoId).filter((x): x is number => typeof x === "number");
    const tecnici = tecIds.length
      ? await db.select().from(tecniciTable).where(sql`${tecniciTable.id} = ANY(${tecIds})`)
      : [];
    const tecById = new Map(tecnici.map(t => [t.id, t]));
    res.json({ richieste: rows.map(r => richiestaToJson(r, r.tecnicoId ? tecById.get(r.tecnicoId) ?? null : null)) });
  });

  app.get("/api/cliente/richiesta/:id", async (req: Request, res: Response) => {
    const tel = authCliente(req);
    if (!tel) return res.status(401).json({ errore: "Non autenticato" });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ errore: "ID non valido" });
    const [r] = await db.select().from(richiesteTable).where(and(eq(richiesteTable.id, id), eq(richiesteTable.telefono, tel)));
    if (!r) return res.status(404).json({ errore: "Richiesta non trovata" });
    let tec = null;
    if (r.tecnicoId) {
      const [t] = await db.select().from(tecniciTable).where(eq(tecniciTable.id, r.tecnicoId));
      tec = t ?? null;
    }
    res.json({ richiesta: richiestaToJson(r, tec) });
  });

  app.post("/api/cliente/richiesta", async (req: Request, res: Response) => {
    const tel = authCliente(req);
    if (!tel) return res.status(401).json({ errore: "Non autenticato" });
    const body = (req.body ?? {}) as Record<string, string>;
    const nome = (body.nome ?? "").trim().slice(0, 100);
    const indirizzo = (body.indirizzo ?? "").trim().slice(0, 200);
    const cap = (body.cap ?? "").trim();
    const servizio = (body.servizio ?? "").trim().toLowerCase();
    const fascia = (body.fasciaOraria ?? "standard").trim().toLowerCase();
    if (!nome || !indirizzo) return res.status(400).json({ errore: "Nome e indirizzo obbligatori" });
    if (!SERVIZI_VALIDI.has(servizio)) return res.status(400).json({ errore: "Servizio non valido" });
    if (!FASCE_VALIDE.has(fascia)) return res.status(400).json({ errore: "Fascia oraria non valida" });
    if (!CAP_REGEX.test(cap)) return res.status(400).json({ errore: "CAP non valido (5 cifre)" });
    const prezzo = calcolaPrezzo(servizio, fascia);
    const [record] = await db.insert(richiesteTable).values({
      nome, telefono: tel, indirizzo, cap, servizio,
      fasciaOraria: fascia, prezzoUscitaCents: prezzo,
      accettazioneCondizioni: "accettato_da_app_cliente",
    }).returning();
    req.log.info({ id: record.id, telefono: tel, servizio, cap }, "Nuova richiesta da app cliente");
    res.json({ successo: true, richiesta: richiestaToJson(record) });
  });

  app.post("/api/cliente/richiesta/:id/annulla", async (req: Request, res: Response) => {
    const tel = authCliente(req);
    if (!tel) return res.status(401).json({ errore: "Non autenticato" });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ errore: "ID non valido" });
    const [r] = await db.select().from(richiesteTable).where(and(eq(richiesteTable.id, id), eq(richiesteTable.telefono, tel)));
    if (!r) return res.status(404).json({ errore: "Richiesta non trovata" });
    if (!["in_attesa", "assegnata"].includes(r.stato)) {
      return res.status(400).json({ errore: "Non puoi annullare una richiesta già in corso o completata" });
    }
    await db.update(richiesteTable).set({ stato: "annullata", tecnicoId: null }).where(eq(richiesteTable.id, id));
    res.json({ successo: true });
  });

  // ── Pagine HTML (SPA) ────────────────────────────
  app.get("/cliente", (_req, res, next: NextFunction) => res.send(CLIENTE_HTML) ?? next);
  app.get("/cliente/manifest.json", (_req, res) => {
    res.json({
      name: "prontointerventomi.it",
      short_name: "ProntoMI",
      start_url: "/cliente",
      display: "standalone",
      background_color: "#f4f6fb",
      theme_color: "#0f2244",
      icons: [
        { src: "/cliente/icon.svg", sizes: "any", type: "image/svg+xml" },
      ],
    });
  });
  app.get("/cliente/icon.svg", (_req, res) => {
    res.type("image/svg+xml").send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e74c3c"/><stop offset="1" stop-color="#c0392b"/></linearGradient></defs><rect width="192" height="192" rx="38" fill="url(#g)"/><path d="M104 28 56 108h32l-12 56 56-84h-32z" fill="#fff"/></svg>`);
  });
}

const CLIENTE_HTML = `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"/>
<meta name="theme-color" content="#0f2244"/>
<meta name="apple-mobile-web-app-capable" content="yes"/>
<meta name="apple-mobile-web-app-status-bar-style" content="default"/>
<meta name="apple-mobile-web-app-title" content="ProntoMI"/>
<link rel="manifest" href="/cliente/manifest.json"/>
<link rel="apple-touch-icon" href="/cliente/icon.svg"/>
<title>prontointerventomi.it — Cliente</title>
<style>
:root{--navy:#0f2244;--red:#dc2626;--green:#16a34a;--border:#e5e9f2;--bg:#f4f6fb}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{height:100%;overflow:hidden}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--navy);-webkit-font-smoothing:antialiased}
#app{height:100vh;height:100dvh;display:flex;flex-direction:column}
.screen{flex:1;display:none;flex-direction:column;overflow:hidden}
.screen.active{display:flex}
/* ── Topbar ── */
.topbar{background:var(--navy);color:#fff;padding:env(safe-area-inset-top) 1rem .9rem;position:relative}
.topbar-inner{display:flex;align-items:center;gap:.7rem;padding-top:.9rem;position:relative;z-index:1}
.topbar-logo{width:30px;height:30px;object-fit:contain;border-radius:4px}
.back{background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.25);color:#fff;width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:1.2rem;cursor:pointer;flex-shrink:0}
.back:active{background:rgba(255,255,255,.3)}
.topbar h1{font-size:1.05rem;font-weight:700;flex:1;line-height:1.2}
.topbar .sub{font-size:.72rem;opacity:.8;margin-top:.12rem;font-weight:400}
/* ── Scroll ── */
.scroll{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;background:var(--bg)}
.scroll-pad{padding:1.2rem 1rem 6rem}
/* ── Login ── */
.login{background:#fff;padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom)}
.login-header{background:var(--navy);padding:calc(env(safe-area-inset-top) + 2.5rem) 1.5rem 2.8rem;text-align:center;position:relative;overflow:hidden}
.login-header::after{content:"";position:absolute;bottom:-1px;left:0;right:0;height:32px;background:#fff;border-radius:32px 32px 0 0}
.login-logo{width:110px;height:110px;object-fit:contain;margin:0 auto 1rem;display:block;filter:drop-shadow(0 8px 24px rgba(0,0,0,.25))}
.login-brand{font-size:1rem;font-weight:800;color:#fff;letter-spacing:-.2px}
.login-elettro{font-size:.62rem;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,.6);margin-top:.3rem;display:block}
.login-body{padding:1.8rem 1.5rem;flex:1;overflow-y:auto}
.login-body h2{font-size:1.4rem;font-weight:800;color:var(--navy);margin-bottom:.4rem;letter-spacing:-.4px}
.login-body .desc{font-size:.92rem;color:#64748b;margin-bottom:1.6rem;line-height:1.5}
.login label{display:block;font-size:.72rem;font-weight:700;color:var(--navy);text-transform:uppercase;letter-spacing:.5px;margin-bottom:.4rem;margin-top:1.1rem}
.login input{width:100%;padding:.9rem 1rem;background:#f8fafc;border:1.5px solid var(--border);border-radius:.7rem;font-size:1rem;color:var(--navy);font-family:inherit}
.login input:focus{outline:none;border-color:var(--navy);background:#fff}
.login input::placeholder{color:#a0aec0}
.login-btn{width:100%;margin-top:1.6rem;padding:1.05rem;background:var(--red);color:#fff;border:none;border-radius:.7rem;font-size:1rem;font-weight:700;cursor:pointer;letter-spacing:.3px;box-shadow:0 6px 18px rgba(220,38,38,.3)}
.login-btn:disabled{opacity:.6}
.login .err{background:#fee2e2;border:1px solid #fecaca;color:#991b1b;padding:.7rem .9rem;border-radius:.5rem;font-size:.85rem;margin-top:1rem;display:none}
.login .err.show{display:block}
/* ── Dashboard ── */
.stats{display:grid;grid-template-columns:1fr 1fr;gap:.7rem;margin-bottom:1.2rem}
.stat{background:#fff;border-radius:.85rem;padding:.95rem 1rem;box-shadow:0 1px 4px rgba(15,34,68,.07);border:1px solid var(--border)}
.stat .num{font-size:1.6rem;font-weight:800;color:var(--red);line-height:1}
.stat .lbl{font-size:.7rem;color:#64748b;margin-top:.25rem;text-transform:uppercase;letter-spacing:.4px;font-weight:600}
.section-title{font-size:.76rem;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.7px;margin:1.4rem .1rem .7rem}
.card{background:#fff;border-radius:.95rem;padding:1.05rem 1.1rem;box-shadow:0 1px 4px rgba(15,34,68,.07);border:1px solid var(--border);margin-bottom:.7rem;cursor:pointer;transition:transform .1s}
.card:active{transform:scale(.985);border-color:#cbd5e1}
.card-head{display:flex;align-items:flex-start;gap:.7rem;margin-bottom:.5rem}
.card-icon{width:38px;height:38px;border-radius:10px;background:#fff1f1;display:flex;align-items:center;justify-content:center;font-size:1.25rem;flex-shrink:0}
.card-title{flex:1;font-weight:700;font-size:.95rem;line-height:1.25;color:var(--navy)}
.card-subtitle{font-size:.78rem;color:#64748b;margin-top:.15rem}
.badge{display:inline-block;padding:.22rem .55rem;border-radius:.5rem;font-size:.7rem;font-weight:700;letter-spacing:.2px}
.card-meta{display:flex;justify-content:space-between;align-items:center;font-size:.78rem;color:#64748b;margin-top:.5rem;padding-top:.6rem;border-top:1px solid var(--border)}
.empty{text-align:center;padding:3rem 1rem;color:#94a3b8}
.empty .em{font-size:2.5rem;margin-bottom:.6rem;opacity:.5}
.empty .et{font-size:.95rem;font-weight:600;color:#475569}
.empty .es{font-size:.8rem;margin-top:.3rem}
.fab{position:fixed;bottom:calc(env(safe-area-inset-bottom) + 1.2rem);right:1.2rem;background:var(--red);color:#fff;border:none;width:auto;height:54px;border-radius:27px;padding:0 1.4rem;font-size:.95rem;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:.5rem;box-shadow:0 6px 20px rgba(220,38,38,.4);z-index:5}
.fab:active{transform:scale(.96)}
.fab span{font-size:1.4rem;line-height:1;font-weight:300}
/* ── Detail ── */
.det-section{background:#fff;border-radius:.95rem;padding:1.2rem 1.1rem;margin-bottom:.85rem;box-shadow:0 1px 4px rgba(15,34,68,.07);border:1px solid var(--border)}
.det-stato{padding:1.4rem 1.1rem;text-align:center}
.det-stato .stato-icon{font-size:2.5rem;margin-bottom:.4rem}
.det-stato .stato-txt{font-size:1.05rem;font-weight:700;letter-spacing:-.2px}
.det-stato .stato-sub{font-size:.78rem;opacity:.75;margin-top:.3rem}
.det-row{display:flex;justify-content:space-between;align-items:flex-start;padding:.6rem 0;border-bottom:1px solid var(--border);gap:1rem}
.det-row:last-child{border-bottom:none}
.det-row .lbl{font-size:.75rem;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.4px;flex-shrink:0;padding-top:.1rem}
.det-row .val{font-size:.92rem;color:var(--navy);font-weight:600;text-align:right;line-height:1.35}
.det-section h3{font-size:.75rem;font-weight:700;color:var(--red);text-transform:uppercase;letter-spacing:.6px;margin-bottom:.6rem}
.tecnico-card{display:flex;align-items:center;gap:.8rem;padding:.6rem 0}
.tecnico-avatar{width:48px;height:48px;border-radius:24px;background:var(--navy);color:#fff;display:flex;align-items:center;justify-content:center;font-size:1.1rem;font-weight:700;flex-shrink:0}
.tecnico-info{flex:1}
.tecnico-info .nm{font-weight:700;font-size:.95rem;color:var(--navy)}
.tecnico-info .rt{font-size:.78rem;color:#64748b;margin-top:.15rem}
.btn-call{background:var(--green);color:#fff;border:none;padding:.6rem 1rem;border-radius:.6rem;font-size:.85rem;font-weight:700;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:.4rem}
.btn-call:active{transform:scale(.96)}
.det-actions{padding:.5rem 1rem 1rem;display:flex;gap:.6rem;flex-direction:column}
.btn-primary,.btn-danger,.btn-secondary{padding:1rem;border-radius:.7rem;font-size:.95rem;font-weight:700;cursor:pointer;border:none;width:100%;font-family:inherit}
.btn-primary{background:var(--red);color:#fff;box-shadow:0 4px 12px rgba(220,38,38,.3)}
.btn-danger{background:#fff;color:var(--red);border:1.5px solid #fecaca}
.btn-secondary{background:var(--bg);color:#475569;border:1.5px solid var(--border)}
/* ── Form ── */
.form-group{margin-bottom:1.1rem}
.form-group label{display:block;font-size:.72rem;font-weight:700;color:var(--navy);margin-bottom:.4rem;text-transform:uppercase;letter-spacing:.4px}
.form-group input,.form-group textarea,.form-group select{width:100%;padding:.85rem .9rem;border:1.5px solid var(--border);border-radius:.6rem;font-size:.95rem;background:#fff;font-family:inherit;color:var(--navy)}
.form-group input:focus,.form-group textarea:focus,.form-group select:focus{outline:none;border-color:var(--navy)}
.serv-grid{display:grid;grid-template-columns:1fr 1fr;gap:.55rem}
.serv-opt{padding:.85rem .5rem;border:2px solid var(--border);border-radius:.7rem;background:#fff;cursor:pointer;text-align:center;transition:all .15s;font-family:inherit}
.serv-opt:active{transform:scale(.97)}
.serv-opt.sel{border-color:var(--red);background:#fff1f1}
.serv-opt .si{font-size:1.5rem;display:block;margin-bottom:.25rem}
.serv-opt .sn{font-size:.78rem;font-weight:600;color:#475569;line-height:1.2}
.serv-opt.sel .sn{color:var(--red)}
.fasce{display:flex;flex-direction:column;gap:.5rem}
.fascia-opt{padding:.9rem;border:2px solid var(--border);border-radius:.6rem;background:#fff;cursor:pointer;display:flex;justify-content:space-between;align-items:center;font-family:inherit;text-align:left}
.fascia-opt.sel{border-color:var(--navy);background:#eef2ff}
.fascia-opt .fn{font-size:.9rem;font-weight:600;color:var(--navy)}
.fascia-opt .fp{font-size:.85rem;font-weight:700;color:var(--red)}
.err-box{background:#fee2e2;color:#991b1b;padding:.7rem .9rem;border-radius:.5rem;font-size:.85rem;margin:.5rem 0 1rem;display:none}
.err-box.show{display:block}
.spinner{display:inline-block;width:18px;height:18px;border:2.5px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle}
@keyframes spin{to{transform:rotate(360deg)}}
.success-overlay{position:fixed;inset:0;background:rgba(15,34,68,.6);display:none;align-items:center;justify-content:center;z-index:100;padding:2rem}
.success-overlay.show{display:flex}
.success-card{background:#fff;border-radius:1.2rem;padding:2.2rem 1.5rem;text-align:center;max-width:340px;width:100%;animation:pop .3s ease-out}
@keyframes pop{from{transform:scale(.85);opacity:0}to{transform:scale(1);opacity:1}}
.success-card .ic{width:72px;height:72px;border-radius:36px;background:#dcfce7;color:#166534;display:flex;align-items:center;justify-content:center;font-size:2.4rem;margin:0 auto 1rem}
.success-card h3{font-size:1.25rem;font-weight:800;color:var(--navy);margin-bottom:.5rem}
.success-card p{font-size:.9rem;color:#64748b;line-height:1.45;margin-bottom:1.5rem}
.success-card button{padding:.9rem 1.5rem;background:var(--red);color:#fff;border:none;border-radius:.6rem;font-size:.95rem;font-weight:700;cursor:pointer;width:100%}
.loader{padding:3rem;text-align:center;color:#94a3b8}
.loader-spin{width:32px;height:32px;border:3px solid var(--border);border-top-color:var(--red);border-radius:50%;animation:spin .7s linear infinite;margin:0 auto .8rem}
@media(min-width:600px){#app{max-width:480px;margin:0 auto;box-shadow:0 0 40px rgba(15,34,68,.12)}}
/* ── HOME SCREEN ── */
.home-hero{background:var(--navy);padding:calc(env(safe-area-inset-top) + 1.6rem) 1.5rem 2.8rem;text-align:center;position:relative}
.home-hero::after{content:"";position:absolute;bottom:-1px;left:0;right:0;height:30px;background:var(--bg);border-radius:30px 30px 0 0}
.home-logo{width:108px;height:108px;object-fit:contain;margin:0 auto .9rem;display:block;filter:drop-shadow(0 8px 24px rgba(0,0,0,.28))}
.home-brand{font-size:.95rem;font-weight:800;color:#fff;letter-spacing:-.2px}
.home-sub{font-size:.6rem;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,.55);margin-top:.25rem}
.home-avail{display:inline-flex;align-items:center;gap:.4rem;background:rgba(22,163,74,.2);border:1px solid rgba(22,163,74,.4);border-radius:2rem;padding:.3rem .9rem;font-size:.65rem;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#4ade80;margin:.8rem auto 0}
/* Trust */
.trust-home{display:grid;grid-template-columns:repeat(2,1fr);gap:.55rem;padding:1rem 1rem .4rem}
.th-item{background:#fff;border:1px solid var(--border);border-radius:.7rem;padding:.8rem .6rem;text-align:center;box-shadow:0 1px 4px rgba(15,34,68,.06)}
.th-n{font-size:1.25rem;font-weight:900;color:#ea580c;line-height:1}
.th-l{font-size:.6rem;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.3px;margin-top:.2rem;line-height:1.3}
/* Services */
.hs-title{font-size:.7rem;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.7px;padding:.9rem 1rem .5rem}
.hs-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:.5rem;padding:0 1rem}
.hs-card{background:#fff;border:1.5px solid var(--border);border-radius:.85rem;padding:.95rem .8rem;position:relative;overflow:hidden}
.hs-card::before{content:"";position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,var(--red),#ea580c)}
.hs-ico{font-size:1.45rem;display:block;margin-bottom:.3rem}
.hs-name{font-size:.82rem;font-weight:700;color:var(--navy)}
.hs-desc{font-size:.67rem;color:#64748b;margin-top:.12rem;line-height:1.35}
/* How it works */
.how-wrap{background:var(--navy);margin:1rem;border-radius:1rem;padding:1.2rem 1rem 1.4rem}
.how-title{font-size:.68rem;font-weight:700;color:rgba(255,255,255,.5);text-transform:uppercase;letter-spacing:.7px;margin-bottom:1rem;text-align:center}
.how-steps{display:flex;flex-direction:column;gap:.85rem}
.how-step{display:flex;align-items:flex-start;gap:.85rem}
.how-num{width:36px;height:36px;border-radius:50%;background:var(--red);color:#fff;display:flex;align-items:center;justify-content:center;font-size:.85rem;font-weight:900;flex-shrink:0}
.how-t{font-size:.88rem;font-weight:700;color:#fff}
.how-s{font-size:.7rem;color:rgba(255,255,255,.6);margin-top:.15rem;line-height:1.4}
/* Home CTAs */
.home-ctas{padding:1rem;display:flex;flex-direction:column;gap:.55rem}
.h-cta-red{background:var(--red);color:#fff;border:none;padding:1.05rem;border-radius:.75rem;font-size:1rem;font-weight:700;cursor:pointer;font-family:inherit;box-shadow:0 6px 18px rgba(220,38,38,.3);width:100%}
.h-cta-navy{background:var(--navy);color:#fff;border:none;padding:.9rem;border-radius:.75rem;font-size:.9rem;font-weight:700;cursor:pointer;font-family:inherit;width:100%;display:none}
.h-cta-call{background:#fff;color:var(--navy);border:2px solid var(--border);padding:.9rem;border-radius:.75rem;font-size:.9rem;font-weight:700;text-decoration:none;display:block;text-align:center}
/* Bottom nav */
.bottom-nav{display:flex;background:#fff;border-top:1px solid var(--border);padding-bottom:env(safe-area-inset-bottom);flex-shrink:0}
.bn{flex:1;display:flex;flex-direction:column;align-items:center;padding:.55rem .4rem .4rem;background:none;border:none;cursor:pointer;font-family:inherit;gap:.15rem;text-decoration:none}
.bn-i{font-size:1.2rem;line-height:1}
.bn-l{font-size:.58rem;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.2px}
.bn.active .bn-l{color:var(--red)}
/* logged-out login hint in home */
.home-login-hint{text-align:center;font-size:.78rem;color:#64748b;padding:.3rem 1rem;margin-bottom:.5rem}
.home-login-hint a{color:var(--navy);font-weight:700;cursor:pointer;text-decoration:underline}
</style>
</head>
<body>
<div id="app">
  <!-- HOME -->
  <div class="screen active" id="screen-home">
    <div class="scroll">
      <div class="home-hero">
        <img class="home-logo" src="/pim-logo.png" alt="PIM Logo"/>
        <div class="home-brand">prontointerventomi.it</div>
        <div class="home-sub">by ELETTROTECH</div>
        <div class="home-avail"><span class="avail-dot"></span> Disponibile ORA a Milano</div>
      </div>
      <!-- Trust strip -->
      <div class="trust-home">
        <div class="th-item"><div class="th-n">500+</div><div class="th-l">Interventi completati</div></div>
        <div class="th-item"><div class="th-n">4.9★</div><div class="th-l">Valutazione media</div></div>
        <div class="th-item"><div class="th-n">90 min</div><div class="th-l">Tempo medio arrivo</div></div>
        <div class="th-item"><div class="th-n">24/7</div><div class="th-l">Sempre disponibili</div></div>
      </div>
      <!-- Servizi -->
      <div class="hs-title">I NOSTRI SERVIZI</div>
      <div class="hs-grid">
        <div class="hs-card"><span class="hs-ico">⚡</span><div class="hs-name">Impianti elettrici</div><div class="hs-desc">Guasti, quadri, messa a norma</div></div>
        <div class="hs-card"><span class="hs-ico">🔔</span><div class="hs-name">Allarmi</div><div class="hs-desc">Installazione e riparazione</div></div>
        <div class="hs-card"><span class="hs-ico">🚪</span><div class="hs-name">Cancelli automatici</div><div class="hs-desc">Automazione, motori, citofoni</div></div>
        <div class="hs-card"><span class="hs-ico">📡</span><div class="hs-name">Antenne TV</div><div class="hs-desc">Digitale terrestre e satellite</div></div>
      </div>
      <!-- Come funziona -->
      <div class="how-wrap">
        <div class="how-title">COME FUNZIONA</div>
        <div class="how-steps">
          <div class="how-step"><div class="how-num">1</div><div><div class="how-t">Richiedi online o chiama</div><div class="how-s">Descrivi il problema e l'indirizzo in 30 secondi</div></div></div>
          <div class="how-step"><div class="how-num">2</div><div><div class="how-t">Tecnico assegnato subito</div><div class="how-s">Il professionista più vicino parte immediatamente</div></div></div>
          <div class="how-step"><div class="how-num">3</div><div><div class="how-t">Problema risolto</div><div class="how-s">Intervento rapido, prezzo chiaro, paghi alla fine</div></div></div>
        </div>
      </div>
      <!-- CTA -->
      <div class="home-ctas">
        <button class="h-cta-red" onclick="homeCtaNew()">⚡ Richiedi intervento ora</button>
        <button class="h-cta-navy" id="home-dash-btn" onclick="homeCtaDash()">📋 Le mie richieste</button>
        <a class="h-cta-call" href="tel:+393405707813">📞 Chiama: 340 570 7813</a>
      </div>
      <div class="home-login-hint" id="home-login-hint" style="display:none">
        Hai già un account? <a onclick="show('screen-login')">Accedi</a>
      </div>
      <div style="text-align:center;padding:.2rem 1rem 2rem;font-size:.68rem;color:#94a3b8;line-height:1.6">
        prontointerventomi.it · Milano e provincia<br>by ELETTROTECH
      </div>
    </div>
  </div>

  <!-- LOGIN -->
  <div class="screen login" id="screen-login">
    <div class="login-header">
      <img class="login-logo" src="/pim-logo.png" alt="PIM Logo"/>
      <div class="login-brand">prontointerventomi.it</div>
      <span class="login-elettro">by ELETTROTECH</span>
    </div>
    <div class="login-body">
      <h2>Accedi / Registrati</h2>
      <p class="desc">Inserisci nome e numero per richiedere un intervento e monitorare lo stato delle tue richieste.</p>
      <label>Il tuo nome</label>
      <input id="li-nome" type="text" autocomplete="given-name" placeholder="Mario Rossi" maxlength="60"/>
      <label>Numero di telefono</label>
      <input id="li-tel" type="tel" autocomplete="tel" placeholder="333 1234567" inputmode="tel"/>
      <div class="err" id="li-err"></div>
      <button class="login-btn" id="li-btn" onclick="login()">Continua →</button>
      <button onclick="show('screen-home')" style="width:100%;margin-top:.7rem;padding:.8rem;background:none;border:none;color:#64748b;font-size:.88rem;cursor:pointer;font-family:inherit">← Torna alla home</button>
    </div>
  </div>

  <!-- DASHBOARD -->
  <div class="screen" id="screen-dash">
    <div class="topbar">
      <div class="topbar-inner">
        <img class="topbar-logo" src="/pim-logo.png" alt="PIM"/>
        <div style="flex:1">
          <h1 id="dash-greet">Ciao</h1>
          <div class="sub" id="dash-sub">Le tue richieste di intervento</div>
        </div>
        <a href="tel:+393405707813" class="back" title="Chiama supporto" style="font-size:1.05rem;text-decoration:none">📞</a>
        <button class="back" onclick="logout()" title="Esci" style="font-size:1rem">↪</button>
      </div>
    </div>
    <div class="scroll">
      <div class="scroll-pad">
        <div class="stats">
          <div class="stat"><div class="num" id="st-attive">0</div><div class="lbl">In corso</div></div>
          <div class="stat"><div class="num" id="st-tot">0</div><div class="lbl">Totali</div></div>
        </div>
        <div class="section-title">Le tue richieste</div>
        <div id="dash-list"></div>
      </div>
    </div>
    <button class="fab" onclick="showNew()"><span>+</span> Nuova richiesta</button>
    <nav class="bottom-nav">
      <button class="bn" onclick="showHome()"><span class="bn-i">🏠</span><span class="bn-l">Home</span></button>
      <button class="bn active" onclick="openDash()"><span class="bn-i">📋</span><span class="bn-l">Richieste</span></button>
      <button class="bn" onclick="showNew()"><span class="bn-i">➕</span><span class="bn-l">Nuova</span></button>
      <a class="bn" href="tel:+393405707813"><span class="bn-i">📞</span><span class="bn-l">Chiama</span></a>
    </nav>
  </div>

  <!-- DETAIL -->
  <div class="screen" id="screen-det">
    <div class="topbar">
      <div class="topbar-inner">
        <button class="back" onclick="openDash()">←</button>
        <div style="flex:1"><h1>Richiesta intervento</h1><div class="sub" id="det-sub">Dettagli</div></div>
      </div>
    </div>
    <div class="scroll">
      <div class="scroll-pad" id="det-body"></div>
    </div>
    <nav class="bottom-nav">
      <button class="bn" onclick="showHome()"><span class="bn-i">🏠</span><span class="bn-l">Home</span></button>
      <button class="bn active" onclick="openDash()"><span class="bn-i">📋</span><span class="bn-l">Richieste</span></button>
      <button class="bn" onclick="showNew()"><span class="bn-i">➕</span><span class="bn-l">Nuova</span></button>
      <a class="bn" href="tel:+393405707813"><span class="bn-i">📞</span><span class="bn-l">Chiama</span></a>
    </nav>
  </div>

  <!-- NEW REQUEST -->
  <div class="screen" id="screen-new">
    <div class="topbar">
      <div class="topbar-inner">
        <button class="back" onclick="openDash()">←</button>
        <div style="flex:1"><h1>Nuova richiesta</h1><div class="sub">Compila i dettagli dell'intervento</div></div>
      </div>
    </div>
    <div class="scroll">
      <div class="scroll-pad">
        <div class="form-group">
          <label>Tipo di intervento</label>
          <div class="serv-grid" id="new-serv"></div>
        </div>
        <div class="form-group">
          <label>Indirizzo</label>
          <input id="new-ind" type="text" placeholder="Via Roma 12, Milano" autocomplete="street-address"/>
        </div>
        <div class="form-group">
          <label>CAP</label>
          <input id="new-cap" type="text" placeholder="20121" inputmode="numeric" maxlength="5" autocomplete="postal-code"/>
        </div>
        <div class="form-group">
          <label>Quando ti serve?</label>
          <div class="fasce" id="new-fascia"></div>
        </div>
        <div class="form-group">
          <label>Note aggiuntive (opzionale)</label>
          <textarea id="new-note" rows="2" placeholder="Descrivi brevemente il problema..." style="width:100%;padding:.85rem .9rem;border:1.5px solid var(--border);border-radius:.6rem;font-size:.95rem;background:#fff;font-family:inherit;color:var(--navy);resize:none"></textarea>
        </div>
        <div class="err-box" id="new-err"></div>
        <button class="btn-primary" id="new-btn" onclick="invia()">Conferma richiesta</button>
        <p style="font-size:.72rem;color:#94a3b8;text-align:center;margin-top:.9rem;line-height:1.4">Inviando confermi di accettare le condizioni di servizio. Il prezzo include solo l'uscita del tecnico.</p>
      </div>
    </div>
    <nav class="bottom-nav">
      <button class="bn" onclick="showHome()"><span class="bn-i">🏠</span><span class="bn-l">Home</span></button>
      <button class="bn" onclick="openDash()"><span class="bn-i">📋</span><span class="bn-l">Richieste</span></button>
      <button class="bn active" onclick="showNew()"><span class="bn-i">➕</span><span class="bn-l">Nuova</span></button>
      <a class="bn" href="tel:+393405707813"><span class="bn-i">📞</span><span class="bn-l">Chiama</span></a>
    </nav>
  </div>
</div>

<div class="success-overlay" id="success">
  <div class="success-card">
    <div class="ic">✓</div>
    <h3>Richiesta inviata!</h3>
    <p>Stiamo cercando il tecnico più vicino a te. Riceverai un aggiornamento appena uno dei nostri professionisti accetta.</p>
    <button onclick="closeSuccess()">Vedi le mie richieste</button>
  </div>
</div>

<script>
const SERVIZI = [
  { v:"impianti_elettrici", n:"Impianti elettrici", i:"⚡" },
  { v:"allarmi", n:"Allarmi", i:"🔔" },
  { v:"automazione_cancelli", n:"Cancelli", i:"🚪" },
  { v:"citofoni", n:"Citofoni", i:"📞" },
  { v:"antenne", n:"Antenne", i:"📡" },
];
const FASCE = [
  { v:"standard", n:"Standard (entro 4 ore)", p:"70 €" },
  { v:"urgente", n:"Urgente (entro 1,5 ore)", p:"120 €" },
  { v:"notte_festivo", n:"Dopo le 17 / Festivi", p:"200 €" },
];

const state = { token:null, nome:null, telefono:null, richieste:[], current:null, sel:{ servizio:null, fascia:"standard" } };

function $(id){ return document.getElementById(id); }
function show(id){
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  $(id).classList.add('active');
}
function eur(c){ return (c/100).toFixed(2).replace('.',',')+' €'; }
function dt(s){
  if(!s) return '';
  const d = new Date(s);
  return d.toLocaleDateString('it-IT',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
}

function showHome(){
  show('screen-home');
  const dashBtn = $('home-dash-btn');
  const loginHint = $('home-login-hint');
  if(state.token){
    dashBtn.style.display='block';
    if(loginHint) loginHint.style.display='none';
  } else {
    dashBtn.style.display='none';
    if(loginHint) loginHint.style.display='block';
  }
}
function homeCtaNew(){
  if(state.token){ showNew(); }
  else { show('screen-login'); }
}
function homeCtaDash(){
  if(state.token){ openDash(); }
  else { show('screen-login'); }
}

async function api(path, opts){
  const headers = { 'Content-Type':'application/json' };
  if(state.token) headers['Authorization'] = 'Bearer '+state.token;
  const res = await fetch(path, { ...opts, headers:{ ...(opts?.headers||{}), ...headers } });
  const data = await res.json();
  if(!res.ok) throw new Error(data.errore || 'Errore');
  return data;
}

function loadSession(){
  try {
    const s = JSON.parse(localStorage.getItem('cliente_session') || 'null');
    if(s?.token && s?.telefono){
      state.token = s.token;
      state.telefono = s.telefono;
      state.nome = s.nome;
      return true;
    }
  } catch {}
  return false;
}
function saveSession(){
  localStorage.setItem('cliente_session', JSON.stringify({ token:state.token, telefono:state.telefono, nome:state.nome }));
}

async function login(){
  const nome = $('li-nome').value.trim();
  const tel = $('li-tel').value.trim();
  const err = $('li-err'); const btn = $('li-btn');
  err.classList.remove('show');
  if(!nome){ err.textContent='Inserisci il tuo nome'; err.classList.add('show'); return; }
  if(!/^\\+?[0-9\\s]{6,20}$/.test(tel)){ err.textContent='Numero di telefono non valido'; err.classList.add('show'); return; }
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
  try {
    const r = await api('/api/cliente/login', { method:'POST', body: JSON.stringify({ telefono:tel, nome }) });
    state.token = r.token; state.telefono = r.cliente.telefono; state.nome = r.cliente.nome;
    saveSession();
    await openDash();
    startPolling();
  } catch(e){ err.textContent = e.message; err.classList.add('show'); }
  finally { btn.disabled = false; btn.textContent = 'Continua'; }
}

function logout(){
  if(!confirm('Vuoi davvero uscire?')) return;
  stopPolling();
  localStorage.removeItem('cliente_session');
  state.token = state.telefono = state.nome = null;
  showHome();
  $('li-nome').value=''; $('li-tel').value='';
}

async function openDash(){
  show('screen-dash');
  $('dash-greet').textContent = 'Ciao ' + (state.nome?.split(' ')[0] || '') + ' 👋';
  $('dash-list').innerHTML = '<div class="loader"><div class="loader-spin"></div>Carico le tue richieste...</div>';
  try {
    const r = await api('/api/cliente/richieste');
    state.richieste = r.richieste;
    renderDash();
  } catch(e){
    $('dash-list').innerHTML = '<div class="empty"><div class="em">⚠️</div><div class="et">Errore di caricamento</div><div class="es">'+e.message+'</div></div>';
  }
}

function renderDash(){
  const att = state.richieste.filter(r=>['in_attesa','assegnata','accettata'].includes(r.stato)).length;
  $('st-attive').textContent = att;
  $('st-tot').textContent = state.richieste.length;
  if(!state.richieste.length){
    $('dash-list').innerHTML = '<div class="empty"><div class="em">📋</div><div class="et">Nessuna richiesta ancora</div><div class="es">Tocca "Nuova richiesta" per iniziare</div></div>';
    return;
  }
  $('dash-list').innerHTML = state.richieste.map(r =>
    '<div class="card" onclick="openDet('+r.id+')">'+
      '<div class="card-head">'+
        '<div class="card-icon">'+r.servizioIcon+'</div>'+
        '<div style="flex:1">'+
          '<div class="card-title">'+r.servizioLabel+'</div>'+
          '<div class="card-subtitle">'+r.indirizzo+'</div>'+
        '</div>'+
      '</div>'+
      '<div class="card-meta">'+
        '<span class="badge" style="background:'+r.statoBg+';color:'+r.statoCol+'">'+r.statoLabel+'</span>'+
        '<span>'+dt(r.createdAt)+'</span>'+
      '</div>'+
    '</div>'
  ).join('');
}

async function openDet(id){
  show('screen-det');
  $('det-sub').textContent = 'Carico...';
  $('det-body').innerHTML = '<div class="loader"><div class="loader-spin"></div>Carico i dettagli...</div>';
  try {
    const r = await api('/api/cliente/richiesta/'+id);
    state.current = r.richiesta;
    renderDet();
  } catch(e){
    $('det-body').innerHTML = '<div class="empty"><div class="em">⚠️</div><div class="et">Errore</div><div class="es">'+e.message+'</div></div>';
  }
}

function renderDet(){
  const r = state.current;
  $('det-sub').textContent = '#' + r.id + ' • ' + dt(r.createdAt);
  const tecBlock = r.tecnico
    ? '<div class="det-section">'+
        '<h3>Tecnico assegnato</h3>'+
        '<div class="tecnico-card">'+
          '<div class="tecnico-avatar">'+(r.tecnico.nome.charAt(0))+'</div>'+
          '<div class="tecnico-info"><div class="nm">'+r.tecnico.nome+'</div><div class="rt">⭐ '+(r.tecnico.rating/10).toFixed(1)+'/5</div></div>'+
          '<a class="btn-call" href="tel:'+r.tecnico.telefono+'">📞 Chiama</a>'+
        '</div>'+
      '</div>'
    : (['in_attesa','assegnata'].includes(r.stato) ? '<div class="det-section" style="text-align:center;padding:1.5rem 1rem"><div style="font-size:2rem;margin-bottom:.4rem">🔍</div><div style="font-weight:700;font-size:.95rem">Stiamo cercando un tecnico</div><div style="font-size:.8rem;color:#718096;margin-top:.3rem">Ti notificheremo appena uno accetta la richiesta</div></div>' : '');

  const canAnnulla = ['in_attesa','assegnata'].includes(r.stato);
  const canPaga = r.stato === 'completata';

  $('det-body').innerHTML =
    '<div class="det-section det-stato" style="background:'+r.statoBg+';color:'+r.statoCol+'">'+
      '<div class="stato-icon">'+r.servizioIcon+'</div>'+
      '<div class="stato-txt">'+r.statoLabel+'</div>'+
      '<div class="stato-sub">'+r.servizioLabel+'</div>'+
    '</div>'+
    tecBlock +
    '<div class="det-section">'+
      '<h3>Dettagli intervento</h3>'+
      '<div class="det-row"><span class="lbl">Servizio</span><span class="val">'+r.servizioLabel+'</span></div>'+
      '<div class="det-row"><span class="lbl">Indirizzo</span><span class="val">'+r.indirizzo+(r.cap?'<br>'+r.cap+' Milano':'')+'</span></div>'+
      '<div class="det-row"><span class="lbl">Fascia</span><span class="val">'+r.fasciaLabel+'</span></div>'+
      '<div class="det-row"><span class="lbl">Costo uscita</span><span class="val" style="color:#dc2626;font-weight:800">'+eur(r.prezzoUscitaCents)+'</span></div>'+
    '</div>'+
    (canPaga ?
      '<div class="det-section" style="background:#f0fdf4;border:1.5px solid #86efac">'+
        '<h3 style="color:#166534">✅ Intervento completato</h3>'+
        '<p style="font-size:.85rem;color:#166534;margin-bottom:1rem;line-height:1.5">Il tecnico ha completato il lavoro. Puoi ora pagare il costo di uscita in modo sicuro.</p>'+
        '<button class="btn-primary" id="btn-paga" onclick="paga()">🔒 Blocca tecnico ora — '+eur(r.prezzoUscitaCents)+'</button>'+
      '</div>'
    : '') +
    (canAnnulla ? '<button class="btn-danger" onclick="annulla()">Annulla richiesta</button>' : '');
}

async function paga(){
  const btn = document.getElementById('btn-paga');
  if(btn){ btn.textContent = '⏳ Reindirizzamento...'; btn.disabled = true; }
  try {
    const r = await api('/api/cliente/richiesta/'+state.current.id+'/paga', { method:'POST' });
    if(r.url) window.location.href = r.url;
  } catch(e){
    alert('Errore pagamento: '+e.message);
    if(btn){ btn.textContent = '🔒 Blocca tecnico ora'; btn.disabled = false; }
  }
}

async function annulla(){
  if(!confirm('Confermi di voler annullare questa richiesta?')) return;
  try {
    await api('/api/cliente/richiesta/'+state.current.id+'/annulla', { method:'POST' });
    await openDash();
  } catch(e){ alert('Errore: '+e.message); }
}

function showDash(){ openDash(); }
function showNew(){
  if(!state.token){ show('screen-login'); return; }
  show('screen-new');
  state.sel = { servizio:null, fascia:'standard' };
  $('new-ind').value=''; $('new-cap').value='';
  if($('new-note')) $('new-note').value='';
  $('new-err').classList.remove('show');
  $('new-serv').innerHTML = SERVIZI.map(s =>
    '<button type="button" class="serv-opt" data-v="'+s.v+'" onclick="selServ(\\''+s.v+'\\')"><span class="si">'+s.i+'</span><span class="sn">'+s.n+'</span></button>'
  ).join('');
  $('new-fascia').innerHTML = FASCE.map(f =>
    '<button type="button" class="fascia-opt'+(f.v===state.sel.fascia?' sel':'')+'" data-v="'+f.v+'" onclick="selFascia(\\''+f.v+'\\')"><span class="fn">'+f.n+'</span><span class="fp">'+f.p+'</span></button>'
  ).join('');
}
function selServ(v){
  state.sel.servizio = v;
  document.querySelectorAll('#new-serv .serv-opt').forEach(b=>b.classList.toggle('sel', b.dataset.v===v));
}
function selFascia(v){
  state.sel.fascia = v;
  document.querySelectorAll('#new-fascia .fascia-opt').forEach(b=>b.classList.toggle('sel', b.dataset.v===v));
}
async function invia(){
  const err = $('new-err'); err.classList.remove('show');
  const indirizzo = $('new-ind').value.trim();
  const cap = $('new-cap').value.trim();
  if(!state.sel.servizio){ err.textContent='Seleziona il tipo di intervento'; err.classList.add('show'); return; }
  if(!indirizzo){ err.textContent='Inserisci l\\'indirizzo'; err.classList.add('show'); return; }
  if(!/^[0-9]{5}$/.test(cap)){ err.textContent='CAP non valido (5 cifre)'; err.classList.add('show'); return; }
  const btn = $('new-btn'); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
  try {
    await api('/api/cliente/richiesta', { method:'POST', body: JSON.stringify({
      nome: state.nome, indirizzo, cap, servizio: state.sel.servizio, fasciaOraria: state.sel.fascia,
    }) });
    $('success').classList.add('show');
  } catch(e){ err.textContent = e.message; err.classList.add('show'); }
  finally { btn.disabled = false; btn.textContent = 'Conferma richiesta'; }
}
function closeSuccess(){
  $('success').classList.remove('show');
  openDash();
}

// ── Auto-polling: aggiorna lo stato ogni 30 secondi quando la dash è visibile ──
let _pollTimer = null;
function startPolling(){
  stopPolling();
  _pollTimer = setInterval(async () => {
    if(!state.token) return;
    const dashActive = $('screen-dash').classList.contains('active');
    const detActive = $('screen-det').classList.contains('active');
    if(!dashActive && !detActive) return;
    try {
      const r = await api('/api/cliente/richieste');
      const prev = JSON.stringify(state.richieste.map(x=>x.stato));
      state.richieste = r.richieste;
      const next = JSON.stringify(state.richieste.map(x=>x.stato));
      if(dashActive && prev !== next) renderDash();
      if(detActive && state.current){
        const updated = state.richieste.find(x=>x.id===state.current.id);
        if(updated && updated.stato !== state.current.stato){
          state.current = updated;
          renderDet();
        }
      }
    } catch {}
  }, 30000);
}
function stopPolling(){
  if(_pollTimer){ clearInterval(_pollTimer); _pollTimer = null; }
}

// Boot — gestisce ritorno da Stripe
(async function boot(){
  const params = new URLSearchParams(window.location.search);
  // Demo mode: ?demo=login|new|home
  const demo = params.get('demo');
  if(demo === 'login'){ show('screen-login'); return; }
  if(demo === 'new'){
    state.token='demo'; state.nome='Mario Rossi'; state.telefono='3331234567';
    showNew(); return;
  }
  if(demo === 'dash'){
    state.token='demo'; state.nome='Mario Rossi'; state.telefono='3331234567';
    show('screen-dash');
    $('dash-greet').textContent='Ciao Mario 👋';
    $('dash-sub').textContent='Le tue richieste di intervento';
    $('st-attive').textContent='1'; $('st-tot').textContent='2';
    $('dash-list').innerHTML=
      '<div class="card"><div class="card-head"><div class="card-icon">⚡</div><div style="flex:1"><div class="card-title">Impianti elettrici</div><div class="card-subtitle">Via Torino 8, Milano</div></div></div><div class="card-meta"><span class="badge" style="background:#dbeafe;color:#1e40af">Tecnico in arrivo</span><span>21 apr, 14:32</span></div></div>'+
      '<div class="card"><div class="card-head"><div class="card-icon">🔔</div><div style="flex:1"><div class="card-title">Allarmi</div><div class="card-subtitle">Corso Buenos Aires 22</div></div></div><div class="card-meta"><span class="badge" style="background:#dcfce7;color:#166534">Pagato ✓</span><span>18 apr, 09:10</span></div></div>';
    showHome(); // update home-dash-btn
    show('screen-dash');
    return;
  }
  const paidId = params.get('paid');
  const cancelledId = params.get('cancelled');
  if(paidId || cancelledId){
    history.replaceState(null,'','/cliente');
  }
  if(loadSession()){
    showHome(); // mostra home con bottone "Le mie richieste"
    startPolling();
    if(paidId){
      setTimeout(async () => {
        await openDash();
        await openDet(parseInt(paidId,10));
        alert('✅ Pagamento completato con successo! Grazie.');
      }, 300);
    } else if(cancelledId){
      setTimeout(async () => {
        await openDash();
        await openDet(parseInt(cancelledId,10));
      }, 300);
    }
  } else {
    showHome(); // home visibile anche senza login
  }
})();
</script>
</body>
</html>`;
