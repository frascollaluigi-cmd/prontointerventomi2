import { logger } from "./lib/logger";

// ── Configurazione ─────────────────────────────────────────────
// Twilio (SMS al tecnico/cliente — opzionale, attualmente non in uso)
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM_NUMBER;
const twilioEnabled = Boolean(TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM);

// Notifiche admin via Telegram (gratis, ufficiale)
const TG_BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN; // token da @BotFather
const ADMIN_TG_CHAT  = process.env.ADMIN_TG_CHAT_ID;   // chat ID dell'admin
const tgAdminEnabled = Boolean(TG_BOT_TOKEN && ADMIN_TG_CHAT);

// Notifiche admin via WhatsApp (CallMeBot — gratis ma instabile, opzionale)
const ADMIN_WA_PHONE = process.env.ADMIN_WA_PHONE;
const CALLMEBOT_KEY  = process.env.CALLMEBOT_APIKEY;
const waAdminEnabled = Boolean(ADMIN_WA_PHONE && CALLMEBOT_KEY);

// Notifiche admin via Email (Resend — gratis fino a 3000 email/mese)
const ADMIN_EMAIL    = process.env.ADMIN_EMAIL;        // es. "luigi@example.com"
const RESEND_KEY     = process.env.RESEND_API_KEY;     // chiave da resend.com
const RESEND_FROM    = process.env.RESEND_FROM ?? "Pronto Intervento <onboarding@resend.dev>";
const emailAdminEnabled = Boolean(ADMIN_EMAIL && RESEND_KEY);

// ── Twilio SMS (lasciato per compatibilità, attualmente disattivo) ──
type SMSPayload = { to: string; body: string };

export async function inviaSMS(payload: SMSPayload): Promise<{ ok: boolean; sid?: string; error?: string }> {
  if (!twilioEnabled) {
    logger.info({ to: payload.to }, "SMS non configurato (Twilio mancante)");
    return { ok: false, error: "SMS non configurato" };
  }
  try {
    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64");
    const params = new URLSearchParams({ To: payload.to, From: TWILIO_FROM!, Body: payload.body });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const data = await res.json() as { sid?: string; message?: string };
    if (!res.ok) return { ok: false, error: data.message ?? "Errore invio SMS" };
    return { ok: true, sid: data.sid };
  } catch (e) {
    logger.error({ err: e }, "Errore invio SMS");
    return { ok: false, error: String(e) };
  }
}

export async function notificaTecnicoNuovaRichiesta(tecnicoTel: string, servizio: string, indirizzo: string): Promise<void> {
  await inviaSMS({
    to: tecnicoTel,
    body: `prontointerventomi.it: nuova richiesta ${servizio} a ${indirizzo}. Apri l'app per accettare.`,
  });
}

export async function notificaClienteTecnicoAccettato(clienteTel: string, tecnicoNome: string, tecnicoTel: string): Promise<void> {
  await inviaSMS({
    to: clienteTel,
    body: `prontointerventomi.it: il tecnico ${tecnicoNome} è in arrivo. Contatto: ${tecnicoTel}`,
  });
}

// ── Telegram Admin (ufficiale, affidabile) ─────────────────────
async function inviaTelegramAdmin(testo: string): Promise<void> {
  if (!tgAdminEnabled) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: ADMIN_TG_CHAT,
        text: testo,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const data = await res.text();
      logger.warn({ status: res.status, data }, "Telegram non riuscito");
      return;
    }
    logger.info("Notifica Telegram admin inviata");
  } catch (e) {
    logger.error({ err: e }, "Errore invio Telegram admin");
  }
}

// ── WhatsApp Admin via CallMeBot ──────────────────────────────
async function inviaWhatsAppAdmin(testo: string): Promise<void> {
  if (!waAdminEnabled) return;
  try {
    const url = new URL("https://api.callmebot.com/whatsapp.php");
    url.searchParams.set("phone", ADMIN_WA_PHONE!);
    url.searchParams.set("text", testo);
    url.searchParams.set("apikey", CALLMEBOT_KEY!);
    const res = await fetch(url.toString(), { method: "GET" });
    if (!res.ok) {
      logger.warn({ status: res.status }, "CallMeBot WhatsApp non riuscito");
      return;
    }
    logger.info("Notifica WhatsApp admin inviata");
  } catch (e) {
    logger.error({ err: e }, "Errore invio WhatsApp admin");
  }
}

// ── Email Admin via Resend ────────────────────────────────────
async function inviaEmailAdmin(oggetto: string, testoHtml: string, testoPlain: string): Promise<void> {
  if (!emailAdminEnabled) return;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [ADMIN_EMAIL],
        subject: oggetto,
        html: testoHtml,
        text: testoPlain,
      }),
    });
    if (!res.ok) {
      const data = await res.text();
      logger.warn({ status: res.status, data }, "Resend email non riuscito");
      return;
    }
    logger.info("Notifica email admin inviata");
  } catch (e) {
    logger.error({ err: e }, "Errore invio email admin");
  }
}

// ── Telegram: invio file (audio/foto) via base64 dataURL ──────
async function inviaTelegramFile(
  chatId: string,
  dataUrl: string,
  tipo: "audio" | "photo",
  caption?: string,
): Promise<void> {
  if (!TG_BOT_TOKEN) return;
  try {
    const [header, b64] = dataUrl.split(",");
    if (!b64) return;
    const mimeMatch = header?.match(/data:([^;]+)/);
    const mime = mimeMatch?.[1] ?? (tipo === "audio" ? "audio/webm" : "image/jpeg");
    const ext = mime.split("/")[1]?.replace("webm", "webm").replace("jpeg", "jpg") ?? "bin";
    const filename = tipo === "audio" ? `audio.${ext}` : `foto.${ext}`;
    const buf = Buffer.from(b64, "base64");

    const form = new FormData();
    form.append("chat_id", chatId);
    form.append(tipo, new Blob([buf], { type: mime }), filename);
    if (caption) form.append("caption", caption.slice(0, 1024));

    const endpoint = tipo === "audio" ? "sendAudio" : "sendPhoto";
    const res = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/${endpoint}`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) {
      const t = await res.text();
      logger.warn({ status: res.status, t }, `Telegram ${endpoint} fallito`);
    }
  } catch (e) {
    logger.error({ err: e }, `Errore invio file Telegram (${tipo})`);
  }
}

// ── API pubblica: notificaAdmin (manda su tutti i canali configurati) ──
export type EventoAdmin = {
  titolo: string;       // breve, per WhatsApp e oggetto email (es. "🆕 Nuova richiesta")
  righe: string[];      // dettagli riga per riga (es. ["📍 Mario Rossi", "⚡ Impianti elettrici"])
  link?: string;        // link opzionale al pannello admin
  audio_b64?: string;   // dataURL base64 del messaggio vocale (opzionale)
  foto_b64?: string[];  // array di dataURL base64 delle foto (opzionale)
};

export async function notificaAdmin(evento: EventoAdmin): Promise<void> {
  const linkAdmin = evento.link ?? "https://prontointerventomi.it/admin";

  // Telegram: testo HTML con titolo in grassetto + link cliccabile
  const tgText = [
    `<b>${escapeHtml(evento.titolo)}</b>`,
    "",
    ...evento.righe.map(escapeHtml),
    "",
    `👉 <a href="${linkAdmin}">Apri pannello admin</a>`,
  ].join("\n");

  // WhatsApp: testo unico con emoji e a-capo
  const waText = [evento.titolo, "", ...evento.righe, "", `👉 ${linkAdmin}`].join("\n");

  // Email: HTML semplice
  const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#f5f7fa;color:#1a202c">
    <div style="background:white;border-radius:12px;padding:24px;box-shadow:0 4px 12px rgba(0,0,0,.06)">
      <h2 style="margin:0 0 16px;color:#c0392b;font-size:1.3rem">${escapeHtml(evento.titolo)}</h2>
      <div style="font-size:.95rem;line-height:1.7">
        ${evento.righe.map(r => `<div>${escapeHtml(r)}</div>`).join("")}
      </div>
      <a href="${linkAdmin}" style="display:inline-block;margin-top:20px;background:#c0392b;color:white;text-decoration:none;padding:.7rem 1.4rem;border-radius:.5rem;font-weight:600">Apri pannello admin →</a>
    </div>
    <p style="text-align:center;font-size:.75rem;color:#718096;margin-top:16px">prontointerventomi.it</p>
  </div>`;
  const plain = [evento.titolo, "", ...evento.righe, "", linkAdmin].join("\n");

  // Invia messaggio testo + allegati Telegram in sequenza
  const telegramTasks: Promise<void>[] = [inviaTelegramAdmin(tgText)];

  if (tgAdminEnabled && ADMIN_TG_CHAT) {
    if (evento.audio_b64) {
      telegramTasks.push(
        inviaTelegramFile(ADMIN_TG_CHAT, evento.audio_b64, "audio", "🎤 Messaggio vocale del cliente"),
      );
    }
    if (evento.foto_b64?.length) {
      evento.foto_b64.forEach((f, i) => {
        telegramTasks.push(
          inviaTelegramFile(ADMIN_TG_CHAT!, f, "photo", `📷 Foto ${i + 1}/${evento.foto_b64!.length}`),
        );
      });
    }
  }

  await Promise.all([
    ...telegramTasks,
    inviaWhatsAppAdmin(waText),
    inviaEmailAdmin(`[Pronto Intervento] ${evento.titolo}`, html, plain),
  ]);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// ── Stato configurazione ──────────────────────────────────────
// ── Email di conferma al cliente ──────────────────────────────
export async function inviaEmailCliente(opts: {
  nome: string;
  email: string;
  servizio: string;
  indirizzo: string;
  fascia: string;
  prezzoCents: number;
  richiestaId: number;
}): Promise<void> {
  if (!emailAdminEnabled) return;
  const prezzoStr = (opts.prezzoCents / 100).toFixed(2).replace(".", ",") + " €";
  const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#f5f7fa;color:#1a202c">
    <div style="background:white;border-radius:12px;padding:24px;box-shadow:0 4px 12px rgba(0,0,0,.06)">
      <div style="text-align:center;padding-bottom:20px;border-bottom:1px solid #e2e8f0">
        <div style="font-size:2.5rem;margin-bottom:8px">✅</div>
        <h1 style="margin:0;font-size:1.4rem;color:#065f46">Prenotazione confermata!</h1>
      </div>
      <p style="margin:16px 0 4px;font-size:.95rem">Ciao <strong>${escapeHtml(opts.nome)}</strong>,</p>
      <p style="margin:0 0 16px;color:#4a5568;font-size:.9rem">Abbiamo ricevuto la tua richiesta. Un tecnico ti contatterà a breve per confermare l'orario di arrivo.</p>
      <table style="width:100%;border-collapse:collapse;font-size:.9rem;margin-bottom:16px">
        <tr><td style="padding:8px 0;color:#718096;border-bottom:1px solid #e2e8f0">Prenotazione</td><td style="padding:8px 0;font-weight:600;border-bottom:1px solid #e2e8f0">#${opts.richiestaId}</td></tr>
        <tr><td style="padding:8px 0;color:#718096;border-bottom:1px solid #e2e8f0">Servizio</td><td style="padding:8px 0;font-weight:600;border-bottom:1px solid #e2e8f0">${escapeHtml(opts.servizio)}</td></tr>
        <tr><td style="padding:8px 0;color:#718096;border-bottom:1px solid #e2e8f0">Indirizzo</td><td style="padding:8px 0;font-weight:600;border-bottom:1px solid #e2e8f0">${escapeHtml(opts.indirizzo)}</td></tr>
        <tr><td style="padding:8px 0;color:#718096;border-bottom:1px solid #e2e8f0">Fascia</td><td style="padding:8px 0;font-weight:600;border-bottom:1px solid #e2e8f0">${escapeHtml(opts.fascia)}</td></tr>
        <tr><td style="padding:8px 0;color:#718096">Costo uscita</td><td style="padding:8px 0;font-weight:700;color:#d97706">${prezzoStr}</td></tr>
      </table>
      <div style="background:#fef3c7;border:1px solid #fbbf24;border-radius:8px;padding:12px;font-size:.82rem;color:#92400e;margin-bottom:16px">
        ⚠️ Il costo indicato è solo la quota di uscita. Il preventivo finale per i lavori viene concordato sul posto con il tecnico.
      </div>
      <p style="font-size:.82rem;color:#718096;text-align:center;margin:0">Per info: <a href="tel:+393405707813" style="color:#c0392b">340 570 7813</a> · <a href="https://prontointerventomi.it" style="color:#c0392b">prontointerventomi.it</a></p>
    </div>
    <p style="text-align:center;font-size:.72rem;color:#a0aec0;margin-top:12px">by ELETTROTECH · prontointerventomi.it</p>
  </div>`;
  const plain = `Prenotazione confermata #${opts.richiestaId}\n\nCiao ${opts.nome},\nServizio: ${opts.servizio}\nIndirizzo: ${opts.indirizzo}\nFascia: ${opts.fascia}\nCosto uscita: ${prezzoStr}\n\nUn tecnico ti contatterà a breve.\nInfo: 340 570 7813`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [opts.email],
        subject: `✅ Prenotazione confermata #${opts.richiestaId} — Pronto Intervento Milano`,
        html,
        text: plain,
      }),
    });
    if (!res.ok) logger.warn({ status: res.status }, "Email cliente non inviata");
    else logger.info({ richiestaId: opts.richiestaId }, "Email conferma inviata al cliente");
  } catch (e) {
    logger.error({ err: e }, "Errore invio email cliente");
  }
}

// ── Richiesta recensione dopo intervento ─────────────────────
export async function inviaRichiestaRecensione(opts: {
  nome: string;
  telefono: string;
  email?: string | null;
  servizio: string;
  richiestaId: number;
}): Promise<void> {
  const reviewUrl = "https://g.page/r/your-google-review-link"; // sostituire con link Google
  const msg = `Ciao ${opts.nome}! Il tuo intervento (${opts.servizio}) è stato completato. Lascia una recensione su Google e aiuta altri clienti a scegliere Pronto Intervento Milano: ${reviewUrl}`;

  // Via Telegram admin (messaggio manuale da inoltrare, oppure usare un bot dedicato)
  const tgText = [
    `<b>⭐ Richiedi recensione #${opts.richiestaId}</b>`,
    ``,
    `👤 ${escapeHtml(opts.nome)} — ${opts.telefono}`,
    `⚡ ${escapeHtml(opts.servizio)}`,
    ``,
    `📱 Invia a WhatsApp del cliente:`,
    `<code>${msg}</code>`,
  ].join("\n");
  if (tgAdminEnabled) {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: ADMIN_TG_CHAT, text: tgText, parse_mode: "HTML" }),
    }).catch(() => {});
  }

  // Via email al cliente (se disponibile)
  if (emailAdminEnabled && opts.email) {
    const html = `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <h2 style="color:#1a202c">Grazie per aver scelto Pronto Intervento Milano!</h2>
      <p>Ciao <strong>${escapeHtml(opts.nome)}</strong>,<br>il tuo intervento è stato completato. Ci farebbe molto piacere sapere cosa ne pensi.</p>
      <a href="${reviewUrl}" style="display:inline-block;margin:16px 0;background:#f59e0b;color:#fff;text-decoration:none;padding:.8rem 1.6rem;border-radius:8px;font-weight:700">⭐ Lascia una recensione</a>
      <p style="color:#718096;font-size:.85rem">Grazie mille · by ELETTROTECH</p>
    </div>`;
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [opts.email],
        subject: "⭐ Come è andato il tuo intervento? — Pronto Intervento Milano",
        html,
        text: msg,
      }),
    }).catch(() => {});
  }

  logger.info({ richiestaId: opts.richiestaId }, "Richiesta recensione inviata");
}

export const notificheConfigurate = {
  twilio: twilioEnabled,
  telegramAdmin: tgAdminEnabled,
  whatsappAdmin: waAdminEnabled,
  emailAdmin: emailAdminEnabled,
};
