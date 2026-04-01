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

/** Junta mensagens do mesmo número numa janela de silêncio antes de confirmar no backend */
const DEBOUNCE_MS = Number(process.env.WHATSAPP_INBOUND_DEBOUNCE_MS || 10000);

/** @type {Map<string, { parts: string[], timer: ReturnType<typeof setTimeout> | null }>} */
const incomingBuffers = new Map();

function extractTextFromEvolution(data) {
  // Evolution costuma mandar payload com estrutura "data.message" (varia por versão)
  const msg =
    data?.data?.message ||
    data?.message ||
    data?.data?.messages?.[0]?.message ||
    null;
  if (!msg) return '';
  if (typeof msg.conversation === 'string') return msg.conversation;
  if (typeof msg.extendedTextMessage?.text === 'string') return msg.extendedTextMessage.text;
  return '';
}

function extractRemoteJid(data) {
  return (
    data?.data?.key?.remoteJid ||
    data?.data?.messages?.[0]?.key?.remoteJid ||
    data?.key?.remoteJid ||
    null
  );
}

function normalizeWhatsappFromJid(remoteJid) {
  if (!remoteJid) return null;
  // ex.: "351927398547@s.whatsapp.net" -> "351927398547"
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
  // Vários 6 dígitos: usar o último (ex.: utilizador corrige a mensagem)
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
    const msg = json?.message || json?.error || `Erro ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

function flushWhatsappBuffer(whatsappDigits) {
  const buf = incomingBuffers.get(whatsappDigits);
  if (!buf) return;
  incomingBuffers.delete(whatsappDigits);
  const combined = buf.parts.join('\n');
  const code = extractCode(combined);
  if (!code) return;
  confirmOnCommunity({ code, whatsapp: whatsappDigits }).catch((err) => {
    console.error('[wa-verify] confirm failed:', err?.message || err);
  });
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
  return true;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, app: 'wa-verify', time: new Date().toISOString() });
});

// Webhook Evolution: v2.3.x envia também paths com sufixo (ex.: /webhook/evolution/connection-update,
// /webhook/evolution/messages-upsert). Aceitar base e qualquer subpath.
async function evolutionWebhookHandler(req, res) {
  try {
    if (WEBHOOK_SECRET && req.get('x-webhook-secret') !== WEBHOOK_SECRET) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const text = extractTextFromEvolution(req.body);
    const remoteJid = extractRemoteJid(req.body);
    const whatsapp = normalizeWhatsappFromJid(remoteJid);
    if (!whatsapp) return res.json({ ok: true, ignored: true });

    const buffered = bufferIncomingMessage(whatsapp, text);
    if (!buffered) return res.json({ ok: true, ignored: true });

    return res.json({ ok: true, debounced: true, debounceMs: DEBOUNCE_MS });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err?.message || 'Erro' });
  }
}

app.post(/^\/webhook\/evolution(\/.*)?$/, evolutionWebhookHandler);

app.listen(PORT, () => {
  console.log(`[wa-verify] listening on :${PORT} (debounce ${DEBOUNCE_MS}ms)`);
});
