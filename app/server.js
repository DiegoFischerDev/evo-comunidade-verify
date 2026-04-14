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

/** Evita disparar o mesmo flow várias vezes (por número) */
const CREDIT_HELP_COOLDOWN_MS = Number(process.env.CREDIT_HELP_COOLDOWN_MS || 10 * 60 * 1000);
/** @type {Map<string, number>} */
const creditHelpLastTriggeredAt = new Map();

/** Lead na ia-app (POST /api/integration/leads) — ver API-INTEGRACAO.md na raiz do monorepo */
const CREATE_ACCOUNT_COOLDOWN_MS = Number(process.env.CREATE_ACCOUNT_COOLDOWN_MS || 5 * 60 * 1000);
/** @type {Map<string, number>} */
const createAccountLastTriggeredAt = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const CREDIT_HELP_TRIGGER = normalizeText('Ola, preciso de ajuda em relação ao contato da gestora de crédito');

const CREATE_ACCOUNT_TRIGGER = normalizeText('criar conta');

/**
 * @param {string} whatsappDigits
 * @param {string} nome
 * @returns {Promise<{ ok: true, id: number, upload_url: string, lead?: unknown }>}
 */
async function createIaAppLead(whatsappDigits, nome) {
  const base = (process.env.IA_APP_BASE_URL || 'https://ia.rafaapelomundo.com').replace(/\/$/, '');
  const secret = process.env.IA_APP_INTEGRATION_SECRET || '';
  if (!secret) {
    throw new Error('Integração não configurada no servidor.');
  }
  const res = await fetch(`${base}/api/integration/leads`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Integration-Secret': secret,
    },
    body: JSON.stringify({
      whatsapp: whatsappDigits,
      nome: nome || 'Cliente WhatsApp',
    }),
  });
  const raw = await res.text();
  let json = {};
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    json = {};
  }
  if (res.status === 201 && json.ok === true && typeof json.upload_url === 'string' && json.upload_url) {
    return json;
  }
  const apiMsg =
    (Array.isArray(json?.message) ? json.message.join(' ') : json?.message) ||
    json?.error ||
    (raw && raw.length < 800 ? raw.trim() : '') ||
    `Erro HTTP ${res.status}`;
  throw new Error(String(apiMsg).trim() || `Erro HTTP ${res.status}`);
}

async function sendCreateAccountFlow({ whatsappDigits, contactName }) {
  const now = Date.now();
  const last = createAccountLastTriggeredAt.get(whatsappDigits) || 0;
  if (now - last < CREATE_ACCOUNT_COOLDOWN_MS) {
    console.log('[wa-verify] create-account: cooldown', { whatsapp: whatsappDigits });
    return { ok: true, skipped: 'cooldown' };
  }
  createAccountLastTriggeredAt.set(whatsappDigits, now);

  const nome = String(contactName || '').trim() || 'Cliente WhatsApp';

  try {
    const data = await createIaAppLead(whatsappDigits, nome);
    console.log('[wa-verify] create-account: lead criado', { whatsapp: whatsappDigits, id: data.id });
    await sendEvolutionText(whatsappDigits, 'Aqui está o seu link para upload:');
    await sleep(1200);
    await sendEvolutionText(whatsappDigits, String(data.upload_url));
    return { ok: true, sent: 'success' };
  } catch (err) {
    const detail = err?.message || String(err);
    console.warn('[wa-verify] create-account: falhou', { whatsapp: whatsappDigits, detail });
    await sendEvolutionText(whatsappDigits, 'Erro ao criar sua conta');
    await sleep(1200);
    await sendEvolutionText(whatsappDigits, detail);
    return { ok: false, error: detail };
  }
}

async function sendCreditHelpFlow({ whatsappDigits, contactName }) {
  const now = Date.now();
  const last = creditHelpLastTriggeredAt.get(whatsappDigits) || 0;
  if (now - last < CREDIT_HELP_COOLDOWN_MS) {
    console.log('[wa-verify] credit-help: cooldown', { whatsapp: whatsappDigits });
    return { ok: true, skipped: 'cooldown' };
  }
  creditHelpLastTriggeredAt.set(whatsappDigits, now);

  const safeName = String(contactName || '').trim();
  const hello = safeName ? `oi ${safeName} tudo bem?` : 'oi, tudo bem?';

  const messages = [
    hello,
    'Você tem dúvidas ou já quer mesmo iniciar sua análise gratuita com a gestora?',
    'Vou te falar basicamente como funciona o processo de credito habitação',
    'Voce entra em contato com a gestora ou gestor, ele vai recolher os documentos necessarios e vai levar para todos os bancos, nao apenas para o banco que voce ja tem conta. Ele vai ver quais bancos aprovam o financiamento nas condiçoes que voce precisa e quais oferecem melhores taxas. uma vez aprovado, o banco vai dizer o maximo de valor que ele libera pra voce... 100 mil ou 150 mil ou 200 mil.. enfim, sabendo esse valor maximo, voce começa a busca pelas casas dentro desse valor. Esse serviço da gestora é gratuito, quem paga a comissao dela sao os bancos.',
    'Geralmente os bancos pedem 10% de entrada e financiam 90% do valor do imovel',
    'Te indico ver esses videos onde falamos um pouco sobre como foi o nosso processo e outro que tiramos duvidas com a gestora:',
    'https://www.youtube.com/watch?v=nSuXTX0z9Vk',
    'https://www.youtube.com/watch?v=v04RVqeT9aQ',
    'Pra iniciar sua análise você deixa seu contato nesse link e vai receber o contato da gestora por e-mail e a lista de documentos:',
    'https://www.ia.rafaapelomundo.com/credito',
    'E qualquer duvida eu fico a disposição 😃',
  ];

  console.log('[wa-verify] credit-help: sending flow', {
    whatsapp: whatsappDigits,
    name: safeName || null,
    count: messages.length,
  });

  for (const text of messages) {
    await sendEvolutionText(whatsappDigits, text);
    // pequeno intervalo para preservar a ordem no WhatsApp
    await sleep(1200);
  }

  return { ok: true, sent: messages.length };
}

/**
 * Evolution 2.3.x: `messages.upsert` costuma vir como
 * `{ event, instance, data: { key, message } }` ou `data: { messages: [...] } }`.
 */
function listIncomingMessageParts(body) {
  /** @type {{ remoteJid: string, fromMe?: boolean, text: string, pushName?: string }[]} */
  const parts = [];
  const d = body?.data;
  if (!d || typeof d !== 'object') return parts;

  const push = (key, message, pushName) => {
    if (!key?.remoteJid) return;
    const jid = String(key.remoteJid);
    if (jid.includes('@g.us')) return;
    if (jid.endsWith('@lid')) return;
    if (key.fromMe === true) return;
    const text = textFromBaileysMessage(message);
    parts.push({ remoteJid: jid, fromMe: key.fromMe, text, pushName });
  };

  if (d.key && d.message) {
    push(d.key, d.message, d.pushName);
  }

  let raw = d.messages;
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  for (const item of list) {
    if (item?.key && item?.message) push(item.key, item.message, item.pushName || d.pushName);
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
  const raw = String(text || '');
  const t = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const normalized = t.toLowerCase();

  // Regra 1: se tiver "codigo" em qualquer lugar + tiver número(s) de 6 dígitos, extrai o último
  if (normalized.includes('codigo')) {
    const sixes = [...t.matchAll(/\b(\d{6})\b/g)];
    return sixes.length ? sixes[sixes.length - 1][1] : null;
  }

  // Regra 2: se a mensagem for APENAS número (sem mais texto) com 6 dígitos, extrai
  const onlyDigits = raw.trim().replace(/\s+/g, '');
  if (/^\d{6}$/.test(onlyDigits)) {
    return onlyDigits;
  }

  return null;
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
    for (const { remoteJid, text, pushName } of parts) {
      const whatsapp = normalizeWhatsappFromJid(remoteJid);
      if (!whatsapp) continue;
      const trimmed = text && String(text).trim();
      if (!trimmed) continue;

      // Flow: ajuda com gestora de crédito (independente de autenticação/código)
      if (normalizeText(trimmed) === CREDIT_HELP_TRIGGER) {
        sendCreditHelpFlow({ whatsappDigits: whatsapp, contactName: pushName }).catch((err) => {
          console.warn('[wa-verify] credit-help: erro ao enviar flow:', err?.message || err);
        });
        // não bufferiza esta mensagem (evita misturar com confirmação por código)
        anyBuffered = true;
        continue;
      }

      // Flow: criar lead na ia-app (upload / documentos)
      if (normalizeText(trimmed) === CREATE_ACCOUNT_TRIGGER) {
        sendCreateAccountFlow({ whatsappDigits: whatsapp, contactName: pushName }).catch((err) => {
          console.warn('[wa-verify] create-account: exceção:', err?.message || err);
        });
        anyBuffered = true;
        continue;
      }

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
