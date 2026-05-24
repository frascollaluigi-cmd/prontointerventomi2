import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import { db, richiesteTable, tecniciTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./lib/logger";
import { notificaAdmin, inviaEmailCliente } from "./notifiche";

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY?.trim() || undefined;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET?.trim() || undefined;
export const stripeEnabled = Boolean(STRIPE_KEY?.startsWith("sk_"));

const FEE_PERCENT = 35;

async function stripeCall<T>(path: string, params: URLSearchParams): Promise<T> {
  if (!STRIPE_KEY) throw new Error("Stripe non configurato");
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${STRIPE_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  const data = await res.json() as Record<string, unknown>;
  if (!res.ok) {
    const errMsg = (data.error as { message?: string })?.message ?? "Errore Stripe";
    throw new Error(errMsg);
  }
  return data as T;
}

async function stripeGet<T>(path: string): Promise<T> {
  if (!STRIPE_KEY) throw new Error("Stripe non configurato");
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${STRIPE_KEY}` },
  });
  const data = await res.json() as Record<string, unknown>;
  if (!res.ok) {
    const errMsg = (data.error as { message?: string })?.message ?? "Errore Stripe";
    throw new Error(errMsg);
  }
  return data as T;
}

function verifyStripeSignature(rawBody: Buffer, sigHeader: string, secret: string): boolean {
  const parts: Record<string, string> = {};
  for (const chunk of sigHeader.split(",")) {
    const [k, v] = chunk.split("=");
    if (k && v) parts[k] = v;
  }
  const t = parts["t"];
  const v1 = parts["v1"];
  if (!t || !v1) return false;

  const timestamp = parseInt(t, 10);
  if (isNaN(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) {
    logger.warn({ timestamp }, "Stripe webhook timestamp fuori tolleranza (>5 min)");
    return false;
  }

  const signedPayload = `${t}.${rawBody.toString("utf8")}`;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(signedPayload, "utf8")
    .digest("hex");

  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(v1, "hex"));
}

type StripeAccount = { id: string };
type StripeAccountLink = { url: string };
type StripeCheckoutSession = { id: string; url: string; payment_intent?: string };
type StripePaymentIntent = { id: string; status: string; amount: number; currency: string };

const SERVIZI_LABEL_STRIPE: Record<string, string> = {
  impianti_elettrici: "Impianti elettrici",
  allarmi: "Allarmi",
  automazione_cancelli: "Automazione cancelli",
  citofoni: "Citofoni",
  antenne: "Antenne TV",
};

/**
 * Crea una Stripe Checkout session con capture_method=manual.
 * La carta viene solo autorizzata, NON addebitata subito.
 * La cattura avviene manualmente dall'admin dopo l'intervento.
 */
export async function creaCheckoutUscita(opts: {
  richiestaId: number;
  nome: string;
  servizio: string;
  indirizzo: string;
  prezzoUscitaCents: number;
  baseUrl: string;
  emailCliente?: string;
}): Promise<string | null> {
  if (!stripeEnabled) return null;
  try {
    const params = new URLSearchParams();
    params.set("mode", "payment");
    params.set("success_url", `${opts.baseUrl}/pagamento-ok?id=${opts.richiestaId}`);
    params.set("cancel_url", `${opts.baseUrl}/?pagamento=annullato&id=${opts.richiestaId}`);
    params.set("line_items[0][price_data][currency]", "eur");
    params.set(
      "line_items[0][price_data][product_data][name]",
      `Conferma intervento — ${SERVIZI_LABEL_STRIPE[opts.servizio] ?? opts.servizio}`,
    );
    params.set(
      "line_items[0][price_data][product_data][description]",
      `Pre-autorizzazione · Intervento a: ${opts.indirizzo} · Prenotazione #${opts.richiestaId}`,
    );
    params.set("line_items[0][price_data][unit_amount]", String(opts.prezzoUscitaCents));
    params.set("line_items[0][quantity]", "1");
    // ── MANUAL CAPTURE: addebito solo su esplicita cattura ──────
    params.set("payment_intent_data[capture_method]", "manual");
    params.set("payment_intent_data[description]", `Uscita tecnico #${opts.richiestaId} — ${opts.indirizzo}`);
    // ────────────────────────────────────────────────────────────
    params.set("metadata[richiesta_id]", String(opts.richiestaId));
    params.set("metadata[cliente]", opts.nome);
    params.set("metadata[servizio]", opts.servizio);
    params.set("metadata[indirizzo]", opts.indirizzo.slice(0, 200));
    if (opts.emailCliente) {
      params.set("metadata[email_cliente]", opts.emailCliente);
      params.set("customer_email", opts.emailCliente);
    }
    params.set("phone_number_collection[enabled]", "false");
    const session = await stripeCall<StripeCheckoutSession>("/checkout/sessions", params);
    return session.url;
  } catch (e) {
    logger.error({ err: e }, "creaCheckoutUscita fallito");
    return null;
  }
}

/**
 * Cattura il pagamento pre-autorizzato (addebita la carta).
 * Da chiamare dopo l'intervento se il cliente vuole pagare con carta.
 */
export async function catturaPagamento(richiestaId: number, importoCents?: number): Promise<{ ok: boolean; errore?: string }> {
  if (!stripeEnabled) return { ok: false, errore: "Stripe non configurato" };
  try {
    const [r] = await db.select().from(richiesteTable).where(eq(richiesteTable.id, richiestaId));
    if (!r) return { ok: false, errore: "Richiesta non trovata" };
    if (!r.stripePaymentIntentId) return { ok: false, errore: "Nessuna autorizzazione Stripe trovata" };
    if (r.stato === "incassato" || r.stato === "pagata") return { ok: false, errore: "Già addebitata" };

    const captureParams = new URLSearchParams();
    if (importoCents && importoCents > 0 && importoCents < r.prezzoUscitaCents) {
      captureParams.set("amount_to_capture", String(importoCents));
    }
    const pi = await stripeCall<StripePaymentIntent>(
      `/payment_intents/${r.stripePaymentIntentId}/capture`,
      captureParams,
    );
    const importoEffettivo = importoCents && importoCents > 0 ? importoCents : r.prezzoUscitaCents;
    await db.update(richiesteTable)
      .set({ stato: "incassato", prezzoUscitaCents: importoEffettivo })
      .where(eq(richiesteTable.id, richiestaId));

    logger.info({ richiestaId, piId: pi.id }, "Pagamento catturato — carta addebitata");
    notificaAdmin({
      titolo: `✅ Pagamento catturato #${richiestaId}`,
      righe: [
        `👤 ${r.nome}`,
        `📍 ${r.indirizzo}`,
        `💶 Importo addebitato: ${(r.prezzoUscitaCents / 100).toFixed(2).replace(".", ",")} €`,
      ],
    }).catch(() => {});

    return { ok: true };
  } catch (e) {
    logger.error({ err: e, richiestaId }, "Errore cattura pagamento");
    return { ok: false, errore: e instanceof Error ? e.message : "Errore sconosciuto" };
  }
}

/**
 * Annulla l'autorizzazione (sblocca i fondi sulla carta del cliente).
 * Da chiamare se il cliente paga in contanti o l'intervento non avviene.
 */
export async function annullaPagamento(richiestaId: number): Promise<{ ok: boolean; errore?: string }> {
  if (!stripeEnabled) return { ok: false, errore: "Stripe non configurato" };
  try {
    const [r] = await db.select().from(richiesteTable).where(eq(richiesteTable.id, richiestaId));
    if (!r) return { ok: false, errore: "Richiesta non trovata" };
    if (!r.stripePaymentIntentId) return { ok: false, errore: "Nessuna autorizzazione Stripe trovata" };
    if (r.stato === "incassato" || r.stato === "pagata") return { ok: false, errore: "Già addebitata — non annullabile" };
    if (["autorizzazione_annullata","annullato","annullata","auth_annullata"].includes(r.stato)) return { ok: false, errore: "Autorizzazione già annullata" };

    await stripeCall<StripePaymentIntent>(
      `/payment_intents/${r.stripePaymentIntentId}/cancel`,
      new URLSearchParams(),
    );
    await db.update(richiesteTable)
      .set({ stato: "autorizzazione_annullata" })
      .where(eq(richiesteTable.id, richiestaId));

    logger.info({ richiestaId, piId: r.stripePaymentIntentId }, "Autorizzazione annullata — fondi sbloccati");
    notificaAdmin({
      titolo: `🔓 Autorizzazione sbloccata #${richiestaId}`,
      righe: [
        `👤 ${r.nome}`,
        `📍 ${r.indirizzo}`,
        `💶 Importo sbloccato: ${(r.prezzoUscitaCents / 100).toFixed(2).replace(".", ",")} €`,
        `💵 Pagamento in contanti sul posto`,
      ],
    }).catch(() => {});

    return { ok: true };
  } catch (e) {
    logger.error({ err: e, richiestaId }, "Errore annullamento autorizzazione");
    return { ok: false, errore: e instanceof Error ? e.message : "Errore sconosciuto" };
  }
}

export function stripeWebhookHandler(req: Request, res: Response): void {
  if (!WEBHOOK_SECRET) {
    logger.warn("Webhook Stripe ricevuto ma STRIPE_WEBHOOK_SECRET non configurato");
    res.status(503).json({ errore: "Webhook non configurato" });
    return;
  }

  const sig = req.headers["stripe-signature"];
  if (!sig || typeof sig !== "string") {
    res.status(400).json({ errore: "Firma mancante" });
    return;
  }

  const rawBody = req.body as Buffer;
  if (!Buffer.isBuffer(rawBody)) {
    res.status(400).json({ errore: "Body non raw — configurazione errata" });
    return;
  }

  if (!verifyStripeSignature(rawBody, sig, WEBHOOK_SECRET)) {
    logger.warn("Webhook Stripe firma non valida");
    res.status(400).json({ errore: "Firma non valida" });
    return;
  }

  type StripeEventMeta = {
    richiesta_id?: string;
    cliente?: string;
    servizio?: string;
    indirizzo?: string;
    email_cliente?: string;
  };
  type StripeSessionObj = {
    metadata?: StripeEventMeta;
    amount_total?: number;
    customer_email?: string;
    payment_intent?: string;
  };
  type StripeEvent = {
    type?: string;
    data?: { object?: StripeSessionObj };
  };

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody.toString("utf8")) as StripeEvent;
  } catch {
    res.status(400).json({ errore: "JSON non valido" });
    return;
  }

  if (event.type === "checkout.session.completed") {
    const obj = event.data?.object ?? {};
    const meta = obj.metadata ?? {};
    const richiestaId = parseInt(meta.richiesta_id ?? "", 10);
    const emailCliente = meta.email_cliente ?? obj.customer_email ?? null;
    const amountTotal = obj.amount_total ?? 0;
    const paymentIntentId = typeof obj.payment_intent === "string" ? obj.payment_intent : null;

    if (Number.isFinite(richiestaId) && richiestaId > 0) {
      db.update(richiesteTable)
        .set(paymentIntentId
          ? { stato: "carta_autorizzata", stripePaymentIntentId: paymentIntentId }
          : { stato: "carta_autorizzata" })
        .where(eq(richiesteTable.id, richiestaId))
        .then(async () => {
          logger.info({ richiestaId, paymentIntentId }, "Checkout completato — carta autorizzata (non addebitata)");

          const prezzoStr = (amountTotal / 100).toFixed(2).replace(".", ",") + " €";
          const fasciaMap: Record<string, string> = {
            standard: "Standard", urgente: "Urgente", notte_festivo: "Serale/Festivi",
          };

          const [r] = await db.select().from(richiesteTable).where(eq(richiesteTable.id, richiestaId)).catch(() => []);

          notificaAdmin({
            titolo: `🔐 Carta autorizzata #${richiestaId} — NON ancora addebitata`,
            righe: [
              `👤 ${meta.cliente ?? r?.nome ?? "Cliente"}`,
              `📞 ${r?.telefono ?? "—"}`,
              `📍 ${meta.indirizzo ?? r?.indirizzo ?? "—"}`,
              `⚡ ${SERVIZI_LABEL_STRIPE[meta.servizio ?? r?.servizio ?? ""] ?? meta.servizio ?? ""}`,
              `🕐 ${fasciaMap[r?.fasciaOraria ?? ""] ?? r?.fasciaOraria ?? ""}`,
              `💶 Pre-autorizzazione: ${prezzoStr}`,
              ...(emailCliente ? [`📧 ${emailCliente}`] : []),
              ``,
              `ℹ️ Vai su /admin per catturare o annullare`,
            ],
          }).catch(() => {});

          if (emailCliente && emailCliente.includes("@") && r) {
            const SERVIZIO_LABEL: Record<string, string> = {
              impianti_elettrici: "Impianti elettrici", allarmi: "Allarmi",
              automazione_cancelli: "Automazione cancelli", citofoni: "Citofoni", antenne: "Antenne TV",
            };
            const FASCIA_LABEL: Record<string, string> = {
              standard: "Standard (entro 4 ore)", urgente: "Urgente (entro 1,5 ore)", notte_festivo: "Dopo le 17 / Festivi",
            };
            inviaEmailCliente({
              nome: r.nome,
              email: emailCliente,
              servizio: SERVIZIO_LABEL[r.servizio] ?? r.servizio,
              indirizzo: r.indirizzo,
              fascia: FASCIA_LABEL[r.fasciaOraria] ?? r.fasciaOraria,
              prezzoCents: amountTotal,
              richiestaId: r.id,
            }).catch(() => {});
          }
        })
        .catch((err) => logger.error({ err, richiestaId }, "Errore aggiornamento stato autorizzata"));
    }
  }

  res.json({ received: true });
}

export function registerStripeRoutes(app: Express): void {
  app.post("/api/tecnico/stripe/onboarding", async (req: Request, res: Response) => {
    if (!stripeEnabled) return res.status(503).json({ errore: "Pagamenti non ancora attivi" });
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) return res.status(401).json({ errore: "Non autenticato" });
    const token = auth.slice(7);
    const [idStr] = Buffer.from(token, "base64").toString("utf8").split(":");
    const id = parseInt(idStr, 10);
    if (!Number.isFinite(id)) return res.status(401).json({ errore: "Token non valido" });
    const [t] = await db.select().from(tecniciTable).where(eq(tecniciTable.id, id));
    if (!t) return res.status(404).json({ errore: "Tecnico non trovato" });

    try {
      let accountId = t.stripeAccountId;
      if (!accountId) {
        const params = new URLSearchParams();
        params.set("type", "express");
        params.set("country", "IT");
        if (t.email) params.set("email", t.email);
        params.set("capabilities[transfers][requested]", "true");
        params.set("business_type", "individual");
        const acc = await stripeCall<StripeAccount>("/accounts", params);
        accountId = acc.id;
        await db.update(tecniciTable).set({ stripeAccountId: accountId }).where(eq(tecniciTable.id, id));
      }
      const proto = req.protocol;
      const host = req.get("host");
      const linkParams = new URLSearchParams();
      linkParams.set("account", accountId);
      linkParams.set("refresh_url", `${proto}://${host}/api/tecnico/stripe/onboarding`);
      linkParams.set("return_url", `${proto}://${host}/api/tecnico/stripe/onboarding/done`);
      linkParams.set("type", "account_onboarding");
      const link = await stripeCall<StripeAccountLink>("/account_links", linkParams);
      res.json({ url: link.url, accountId, completato: false });
    } catch (e) {
      logger.error({ err: e }, "Stripe onboarding fallito");
      res.status(500).json({ errore: e instanceof Error ? e.message : "Errore" });
    }
  });

  app.get("/api/tecnico/stripe/onboarding/done", (req: Request, res: Response) => {
    res.type("text/html").send(`<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Onboarding completato</title></head><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f0fff4"><div style="text-align:center;padding:2rem"><div style="font-size:4rem">✅</div><h1 style="color:#065f46;margin:.5rem 0">Configurazione completata!</h1><p style="color:#4a5568">Il tuo account Stripe è pronto.<br/>Puoi tornare all'app.</p></div></body></html>`);
  });

  app.post("/api/cliente/richiesta/:id/paga", async (req: Request, res: Response) => {
    if (!stripeEnabled) return res.status(503).json({ errore: "Pagamenti non ancora attivi" });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ errore: "ID non valido" });
    const [r] = await db.select().from(richiesteTable).where(eq(richiesteTable.id, id));
    if (!r) return res.status(404).json({ errore: "Richiesta non trovata" });
    if (!r.tecnicoId) return res.status(400).json({ errore: "Nessun tecnico assegnato" });
    if (r.stato === "pagata" || r.stato === "autorizzata") return res.status(400).json({ errore: "Già autorizzata o pagata" });
    const [t] = await db.select().from(tecniciTable).where(eq(tecniciTable.id, r.tecnicoId));
    if (!t?.stripeAccountId) return res.status(400).json({ errore: "Il tecnico non ha ancora configurato i pagamenti Stripe" });

    try {
      const proto = req.protocol;
      const host = req.get("host");
      const total = r.prezzoUscitaCents;
      const fee = Math.round(total * FEE_PERCENT / 100);
      const serviziLabel: Record<string, string> = {
        impianti_elettrici: "Impianti elettrici", allarmi: "Allarmi",
        automazione_cancelli: "Automazione cancelli", citofoni: "Citofoni", antenne: "Antenne",
      };
      const params = new URLSearchParams();
      params.set("mode", "payment");
      params.set("success_url", `${proto}://${host}/cliente?paid=${id}`);
      params.set("cancel_url", `${proto}://${host}/cliente?cancelled=${id}`);
      params.set("line_items[0][price_data][currency]", "eur");
      params.set("line_items[0][price_data][product_data][name]", `${serviziLabel[r.servizio] ?? r.servizio} #${r.id}`);
      params.set("line_items[0][price_data][product_data][description]", `Costo di uscita — ${r.indirizzo}`);
      params.set("line_items[0][price_data][unit_amount]", String(total));
      params.set("line_items[0][quantity]", "1");
      params.set("payment_intent_data[capture_method]", "manual");
      params.set("payment_intent_data[application_fee_amount]", String(fee));
      params.set("payment_intent_data[transfer_data][destination]", t.stripeAccountId);
      params.set("metadata[richiesta_id]", String(r.id));
      const session = await stripeCall<StripeCheckoutSession>("/checkout/sessions", params);
      res.json({ url: session.url, sessionId: session.id });
    } catch (e) {
      logger.error({ err: e }, "Stripe checkout fallito");
      res.status(500).json({ errore: e instanceof Error ? e.message : "Errore" });
    }
  });
}
