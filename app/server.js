const express = require('express');

const app = express();
// Evolution envia payloads grandes (mensagens, metadados, mídia em base64); 1mb causava 413 no Nginx/Express
app.use(express.json({ limit: '25mb' }));

const PORT = process.env.PORT || 3100;

// Segurança: valida que a chamada do webhook veio de quem tem o segredo
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

// Chamada interna para o backend da Comunidade
const COMMUNITY_API_URL = (process.env.COMMUNITY_API_URL || '').replace(/\/$/, '');
const COMMUNITY_INTERNAL_SECRET = process.env.COMMUNITY_INTERNAL_SECRET || '';

// Envio de mensagens via Evolution (resposta automática de teste)
const EVOLUTION_API_URL = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, '');
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || 'comunidade';

const LOG_WEBHOOK = process.env.LOG_WEBHOOK === '1' || process.env.LOG_WEBHOOK === 'true';

/** Junta mensagens do mesmo número numa janela de silêncio antes de confirmar no backend */
const DEBOUNCE_MS = Number(process.env.WHATSAPP_INBOUND_DEBOUNCE_MS || 10000);

/** @type {Map<string, { parts: string[], timer: ReturnType<typeof setTimeout> | null }>} */
const incomingBuffers = new Map();

/**
 * Evolution 2.3.x: `messages.upsert` costuma vir como
 * `{ event, instance, data: { key, message } }` ou `data: { messages: [...] } }`.
 */
function listIncomingMessageParts(body) {
  /** @type {{ remoteJid: string, fromMe?: boolean, text: string }[]} */
  const parts = [];
  const d = body?.data;
  if (!d || typeof d !== 'object') return parts;

  const push = (key, message) => {
    if (!key?.remoteJid) return;
    const jid = String(key.remoteJid);
    if (jid.includes('@g.us')) return;
    if (jid.endsWith('@lid')) return;
    if (key.fromMe === true) return;
    const text = textFromBaileysMessage(message);
    parts.push({ remoteJid: jid, fromMe: key.fromMe, text });
  };

  if (d.key && d.message) {
    push(d.key, d.message);
  }

  let raw = d.messages;
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  for (const item of list) {
    if (item?.key && item?.message) push(item.key, item.message);
  }

  return parts;
}

function textFromBaileysMessage(msg) {
  if (!msg || typeof msg !== 'object') return '';
  if (typeof msg.conversation === 'string') return msg.conversation;
  if (typeof msg.extendedTextMessage?.text === 'string') return msg.extendedTextMessage.text;
  if (typeof msg.imageMessage?.caption === 'string') return msg.imageMessage.caption;
  if (typeof msg.videoMessage?.caption === 'string') return msg.videoMessage.caption;
  const nested = msg.ephemeralMessage?.message || msg.viewOnceMessage?.message;
  if (nested) return textFromBaileysMessage(nested);
  return '';
}

function normalizeWhatsappFromJid(remoteJid) {
  if (!remoteJid) return null;
  return String(remoteJid).split('@')[0].replace(/\D/g, '') || null;
}

function extractCode(text) {
  const t = String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  let m = t.match(/(?:meu\s+)?codigo\s*(?:é|e|=|:)?\s*(\d{4,8})/i);
  if (m) return m[1];
  m = t.match(/codigo\s*:?\s*(\d{4,8})/i);
  if (m) return m[1];
  const sixes = [...t.matchAll(/\b(\d{6})\b/g)];
  if (sixes.length) return sixes[sixes.length - 1][1];
  const any = [...t.matchAll(/\b(\d{4,8})\b/g)];
  return any.length ? any[any.length - 1][1] : null;
}

async function confirmOnCommunity({ code, whatsapp }) {
  if (!COMMUNITY_API_URL) throw new Error('COMMUNITY_API_URL não configurada');
  const res = await fetch(`${COMMUNITY_API_URL}/auth/whatsapp/confirm`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(COMMUNITY_INTERNAL_SECRET ? { 'x-internal-secret': COMMUNITY_INTERNAL_SECRET } : {}),
    },
    body: JSON.stringify({ code, whatsapp }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      (Array.isArray(json?.message) ? json.message.join(' ') : json?.message) ||
      json?.error ||
      `Erro ${res.status}`;
    throw new Error(String(msg));
  }
  return json;
}

async function sendEvolutionText(toDigits, text) {
  const base = EVOLUTION_API_URL.replace(/\/$/, '');
  const key = EVOLUTION_API_KEY;
  const instance = EVOLUTION_INSTANCE || 'comunidade';
  if (!base || !key) {
    console.warn(
      '[wa-verify] EVOLUTION_API_URL ou EVOLUTION_API_KEY ausentes; resposta automática não enviada.',
    );
    return;
  }
  const number = String(toDigits || '').replace(/\D/g, '');
  if (!number) return;
  const res = await fetch(`${base}/message/sendText/${instance}`, {
    method: 'POST',
    headers: { apikey: key, 'content-type': 'application/json' },
    body: JSON.stringify({ number, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.warn('[wa-verify] Evolution sendText falhou:', res.status, body);
  }
}

function flushWhatsappBuffer(whatsappDigits) {
  const buf = incomingBuffers.get(whatsappDigits);
  if (!buf) return;
  incomingBuffers.delete(whatsappDigits);
  const combined = buf.parts.join('\n');
  const code = extractCode(combined);
  if (!code) {
    console.warn('[wa-verify] flush: sem código no texto acumulado', {
      len: combined.length,
      preview: combined.slice(0, 120),
    });
    return;
  }
  console.log('[wa-verify] flush: a confirmar', { whatsapp: whatsappDigits, code });
  confirmOnCommunity({ code, whatsapp: whatsappDigits })
    .then(() => console.log('[wa-verify] conta confirmada no backend', { whatsapp: whatsappDigits }))
    .catch((err) => console.error('[wa-verify] confirm failed:', err?.message || err));
}

function bufferIncomingMessage(whatsappDigits, text) {
  const trimmed = text && String(text).trim();
  if (!trimmed) return false;

  let buf = incomingBuffers.get(whatsappDigits);
  if (!buf) {
    buf = { parts: [], timer: null };
    incomingBuffers.set(whatsappDigits, buf);
  }
  if (buf.timer) clearTimeout(buf.timer);
  buf.parts.push(trimmed);
  buf.timer = setTimeout(() => flushWhatsappBuffer(whatsappDigits), DEBOUNCE_MS);
  console.log('[wa-verify] buffer', {
    whatsapp: whatsappDigits,
    parts: buf.parts.length,
    debounceMs: DEBOUNCE_MS,
    preview: trimmed.slice(0, 80),
  });
  return true;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, app: 'wa-verify', time: new Date().toISOString() });
});

async function evolutionWebhookHandler(req, res) {
  try {
    if (WEBHOOK_SECRET && req.get('x-webhook-secret') !== WEBHOOK_SECRET) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    if (LOG_WEBHOOK) {
      console.log('[wa-verify] webhook raw event=', req.body?.event, 'keys=', req.body?.data ? Object.keys(req.body.data) : []);
    }

    const parts = listIncomingMessageParts(req.body);
    let anyBuffered = false;
    for (const { remoteJid, text } of parts) {
      const whatsapp = normalizeWhatsappFromJid(remoteJid);
      if (!whatsapp) continue;
      const trimmed = text && String(text).trim();
      if (!trimmed) continue;

      // Resposta automática simples para teste do fluxo Evolution
      sendEvolutionText(whatsapp, 'Bom dia tudo bem?').catch((err) => {
        console.warn(
          '[wa-verify] erro ao enviar resposta automática:',
          err?.message || err,
        );
      });

      if (bufferIncomingMessage(whatsapp, trimmed)) anyBuffered = true;
    }

    if (!anyBuffered) {
      return res.json({ ok: true, ignored: true });
    }
    return res.json({ ok: true, debounced: true, debounceMs: DEBOUNCE_MS });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err?.message || 'Erro' });
  }
}

app.post(/^\/webhook\/evolution(\/.*)?$/, evolutionWebhookHandler);

app.listen(PORT, () => {
  console.log(`[wa-verify] listening on :${PORT} (debounce ${DEBOUNCE_MS}ms)`);
});
