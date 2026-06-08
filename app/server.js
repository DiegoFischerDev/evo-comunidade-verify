const express = require('express');

const app = express();
// Evolution envia payloads grandes (mídia em base64 quando Webhook Base64 está ativo).
app.use(express.json({ limit: process.env.WEBHOOK_BODY_LIMIT || '256mb' }));

const PORT = process.env.PORT || 3100;

// Mantemos a validação do segredo do webhook para o caso de o Evolution continuar a chamar
// este endpoint.
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

const LOG_WEBHOOK = process.env.LOG_WEBHOOK === '1' || process.env.LOG_WEBHOOK === 'true';

// ===== Whatsapp scan =====
// O backend NestJS da Comunidade gere a configuração dos grupos monitorizados e a integração
// com a OpenAI. Este receiver apenas reencaminha as mensagens de GRUPO recebidas para o endpoint
// interno `POST /whatsapp-scan/ingest`, autenticando com o segredo partilhado.
const COMMUNITY_API_URL = (process.env.COMMUNITY_API_URL || '').replace(/\/$/, '');
const COMMUNITY_API_URL_FALLBACK = (
  process.env.COMMUNITY_API_URL_FALLBACK || ''
).replace(/\/$/, '');
const COMMUNITY_INTERNAL_SECRET = process.env.COMMUNITY_INTERNAL_SECRET || '';

app.get('/health', (_req, res) => {
  res.json({ ok: true, app: 'wa-verify', time: new Date().toISOString() });
});

/** Extrai o texto de uma mensagem da Evolution (vários formatos possíveis). */
function extractMessageText(message) {
  if (!message || typeof message !== 'object') return '';
  return (
    message.conversation ||
    (message.extendedTextMessage && message.extendedTextMessage.text) ||
    (message.imageMessage && message.imageMessage.caption) ||
    (message.videoMessage && message.videoMessage.caption) ||
    (message.documentMessage && message.documentMessage.caption) ||
    ''
  );
}

/**
 * Extrai a mídia (imagem/vídeo) de uma mensagem da Evolution, incluindo o base64 quando o
 * Webhook Base64 está ativo. Devolve null se não houver mídia suportada.
 */
function extractMedia(message) {
  if (!message || typeof message !== 'object') return null;
  const img = message.imageMessage;
  const vid = message.videoMessage;
  if (img && typeof img === 'object') {
    return {
      kind: 'image',
      base64: img.base64 || message.base64 || '',
      mimeType: img.mimetype || 'image/jpeg',
      fileName: img.fileName || '',
      caption: img.caption || '',
    };
  }
  if (vid && typeof vid === 'object') {
    return {
      kind: 'video',
      base64: vid.base64 || message.base64 || '',
      mimeType: vid.mimetype || 'video/mp4',
      fileName: vid.fileName || '',
      caption: vid.caption || '',
    };
  }
  return null;
}

/**
 * Extrai localização estática ou em tempo real de uma mensagem Evolution/Baileys.
 */
function extractLocation(message) {
  if (!message || typeof message !== 'object') return null;

  const staticLoc = message.locationMessage;
  if (staticLoc && typeof staticLoc === 'object') {
    const latitude = staticLoc.degreesLatitude ?? staticLoc.latitude;
    const longitude = staticLoc.degreesLongitude ?? staticLoc.longitude;
    if (typeof latitude !== 'number' || typeof longitude !== 'number') return null;
    return {
      kind: 'static',
      latitude,
      longitude,
      name: staticLoc.name ? String(staticLoc.name) : '',
      address: staticLoc.address ? String(staticLoc.address) : '',
    };
  }

  const liveLoc = message.liveLocationMessage;
  if (liveLoc && typeof liveLoc === 'object') {
    const latitude = liveLoc.degreesLatitude ?? liveLoc.latitude;
    const longitude = liveLoc.degreesLongitude ?? liveLoc.longitude;
    if (typeof latitude !== 'number' || typeof longitude !== 'number') return null;
    return {
      kind: 'live',
      latitude,
      longitude,
      name: liveLoc.name ? String(liveLoc.name) : '',
      address: liveLoc.address ? String(liveLoc.address) : '',
      accuracyInMeters:
        typeof liveLoc.accuracyInMeters === 'number'
          ? liveLoc.accuracyInMeters
          : undefined,
      sequenceNumber:
        typeof liveLoc.sequenceNumber === 'number'
          ? liveLoc.sequenceNumber
          : undefined,
    };
  }

  return null;
}

/** Apenas dígitos (remove @s.whatsapp.net, +, espaços, etc.). */
function digitsOnly(value) {
  return String(value || '').replace(/\D+/g, '');
}

/** Forma canónica PT: 9xxxxxxxx → 3519xxxxxxxx (alinhado com o backend). */
function canonicalPhoneDigits(value) {
  const d = digitsOnly(value);
  if (!d) return '';
  if (/^9\d{8}$/.test(d)) return `351${d}`;
  return d;
}

/**
 * Extrai dígitos de telefone de um JID; ignora grupos (@g.us) e LID (@lid).
 * Rejeita strings só com dígitos demasiado longas (IDs LID sem sufixo).
 */
function phoneDigitsFromJidOrPhone(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (/@g\.us$/i.test(s) || /@lid$/i.test(s)) return '';
  const local = s.includes('@') ? s.split('@')[0] : s;
  const d = digitsOnly(local);
  if (d.length < 8 || d.length > 15) return '';
  return d;
}

/**
 * Remetente real em mensagens de grupo (Evolution/Baileys).
 * Ordem: senderPn, participantAlt, participant, contextInfo.participant, body.sender.
 * Nunca usa remoteJid do grupo (@g.us).
 */
function extractSenderPhone(key, item, body) {
  const candidates = [
    key && key.senderPn,
    key && key.participantAlt,
    key && key.participant,
    item && item.contextInfo && item.contextInfo.participant,
    body && body.sender,
  ];
  for (const raw of candidates) {
    const d = phoneDigitsFromJidOrPhone(raw);
    if (d) return canonicalPhoneDigits(d);
  }
  return '';
}

/** messageTimestamp da Evolution → segundos Unix (number | string | Long {low}). */
function toUnixSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return parseInt(value, 10);
  if (value && typeof value === 'object' && typeof value.low === 'number') {
    return value.low;
  }
  return undefined;
}

/** Evita reencaminhar o mesmo webhook duas vezes (Evolution duplicada / duas instâncias). */
const locationEchoDedupe = new Map();
const LOCATION_ECHO_DEDUPE_MS = 10 * 60 * 1000;

function locationEchoDedupeKey(payload) {
  const id = payload.externalMessageId;
  if (id) {
    if (payload.locationKind === 'live' && payload.sequenceNumber != null) {
      return `${id}:${payload.sequenceNumber}`;
    }
    return String(id);
  }
  return `${payload.chatJid}|${payload.locationKind}|${payload.latitude}|${payload.longitude}|${payload.sequenceNumber ?? ''}`;
}

function claimLocationEchoDedupe(key) {
  if (!key) return true;
  const now = Date.now();
  for (const [k, ts] of locationEchoDedupe) {
    if (now - ts > LOCATION_ECHO_DEDUPE_MS) locationEchoDedupe.delete(k);
  }
  if (locationEchoDedupe.has(key)) return false;
  locationEchoDedupe.set(key, now);
  return true;
}

/** Envia a mensagem a um endpoint interno do backend; tenta URL principal e fallback. */
async function forwardToBackendPath(path, payload, label) {
  const targets = [COMMUNITY_API_URL, COMMUNITY_API_URL_FALLBACK].filter(Boolean);
  if (!targets.length || !COMMUNITY_INTERNAL_SECRET) {
    if (LOG_WEBHOOK) {
      console.log(`[wa-verify] ${label}: backend não configurado (COMMUNITY_API_URL/SECRET)`);
    }
    return;
  }
  for (const base of targets) {
    try {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-secret': COMMUNITY_INTERNAL_SECRET,
        },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        if (LOG_WEBHOOK) {
          const body = await res.json().catch(() => ({}));
          console.log(`[wa-verify] ${label} forwarded`, body && body.status);
        }
        return;
      }
      if (LOG_WEBHOOK) {
        console.log(`[wa-verify] ${label} backend respondeu`, res.status, 'em', base);
      }
    } catch (e) {
      if (LOG_WEBHOOK) {
        console.log(`[wa-verify] ${label} erro ao reencaminhar para`, base, e && e.message);
      }
    }
  }
}

async function forwardToBackend(payload) {
  await forwardToBackendPath('/whatsapp-scan/ingest', payload, 'scan');
  await forwardToBackendPath('/job-offers/whatsapp/ingest', payload, 'job-offers');
}

/** Reencaminha localizações recebidas (DM ou grupo) para eco de teste no backend. */
async function handleLocationEcho(body) {
  const instance = body && body.instance ? String(body.instance) : '';
  const events = extractMessageEvents(body);
  for (const item of events) {
    try {
      const key = item && item.key ? item.key : {};
      if (key.fromMe === true) continue;

      const chatJid = String(key.remoteJid || '');
      if (!chatJid) continue;

      const location = extractLocation(item.message);
      if (!location) continue;

      const senderNumber = chatJid.endsWith('@g.us')
        ? extractSenderPhone(key, item, body)
        : canonicalPhoneDigits(phoneDigitsFromJidOrPhone(chatJid));

      if (LOG_WEBHOOK) {
        console.log(
          `[wa-verify] location-echo kind=${location.kind} chat=${chatJid} lat=${location.latitude} lng=${location.longitude}`,
        );
      }

      const payload = {
        chatJid,
        senderNumber: senderNumber || undefined,
        locationKind: location.kind,
        latitude: location.latitude,
        longitude: location.longitude,
        name: location.name || undefined,
        address: location.address || undefined,
        accuracyInMeters: location.accuracyInMeters,
        sequenceNumber: location.sequenceNumber,
        externalMessageId: key.id ? String(key.id) : undefined,
        instance: instance || undefined,
      };

      const dedupeKey = locationEchoDedupeKey(payload);
      if (!claimLocationEchoDedupe(dedupeKey)) {
        if (LOG_WEBHOOK) {
          console.log('[wa-verify] location-echo ignorado (duplicado)', dedupeKey);
        }
        continue;
      }

      await forwardToBackendPath(
        '/whatsapp/location-echo/ingest',
        payload,
        'location-echo',
      );
    } catch (e) {
      if (LOG_WEBHOOK) {
        console.log('[wa-verify] location-echo erro', e && e.message);
      }
    }
  }
}

/** Normaliza o(s) evento(s) de mensagem para um array de `{ data }`. */
function extractMessageEvents(body) {
  if (!body || typeof body !== 'object') return [];
  const event = String(body.event || '').toLowerCase().replace(/[._-]/g, '');
  // Aceitamos messages.upsert / messages-upsert / messagesUpsert. Se não vier `event` (alguns
  // setups enviam só o data), tentamos processar à mesma.
  if (event && event !== 'messagesupsert') return [];
  const data = body.data;
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') return [data];
  return [];
}

async function handleScan(body) {
  const instance = body && body.instance ? String(body.instance) : '';
  const events = extractMessageEvents(body);
  for (const item of events) {
    try {
      const key = item && item.key ? item.key : {};
      const remoteJid = String(key.remoteJid || '');
      if (!remoteJid.endsWith('@g.us')) continue;
      if (key.fromMe === true) continue;

      const senderNumber = extractSenderPhone(key, item, body);
      if (!senderNumber) {
        if (LOG_WEBHOOK) {
          console.log(
            '[wa-verify] scan: remetente não identificado',
            JSON.stringify({
              participant: key.participant,
              participantAlt: key.participantAlt,
              senderPn: key.senderPn,
              groupJid: remoteJid,
            }),
          );
        }
        continue;
      }
      const externalMessageId = key.id ? String(key.id) : undefined;
      const messageTimestamp = toUnixSeconds(item.messageTimestamp);

      // Mídia (imagem/vídeo): reencaminha sempre. Se não vier o base64 (Webhook Base64 desligado),
      // o backend busca os bytes na Evolution via getBase64FromMediaMessage usando o id + instância.
      const media = extractMedia(item.message);
      if (media) {
        if (LOG_WEBHOOK) {
          console.log(
            `[wa-verify] scan media kind=${media.kind} base64=${media.base64 ? 'sim' : 'não'} jid=${remoteJid}`,
          );
        }
        await forwardToBackend({
          groupJid: remoteJid,
          senderNumber,
          kind: media.kind,
          base64: media.base64 || undefined,
          mimeType: media.mimeType,
          fileName: media.fileName,
          text: String(media.caption || '').slice(0, 8000),
          externalMessageId,
          instance: instance || undefined,
          messageTimestamp,
        });
        continue;
      }

      // Texto.
      const text = extractMessageText(item.message);
      if (!text || !text.trim()) continue;

      await forwardToBackend({
        groupJid: remoteJid,
        senderNumber,
        kind: 'text',
        text: String(text).slice(0, 8000),
        externalMessageId,
        instance: instance || undefined,
        messageTimestamp,
      });
    } catch (e) {
      if (LOG_WEBHOOK) {
        console.log('[wa-verify] scan erro ao processar evento', e && e.message);
      }
    }
  }
}

function evolutionWebhookHandler(req, res) {
  if (WEBHOOK_SECRET && req.get('x-webhook-secret') !== WEBHOOK_SECRET) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  if (LOG_WEBHOOK) {
    console.log('[wa-verify] webhook event=', req.body && req.body.event);
  }
  // Processamento assíncrono (best-effort) — respondemos já 200 para a Evolution não reentregar.
  void handleScan(req.body);
  void handleLocationEcho(req.body);
  return res.json({ ok: true });
}

app.post(/^\/webhook\/evolution(\/.*)?$/, evolutionWebhookHandler);

app.listen(PORT, () => {
  console.log(
    `[wa-verify] listening on :${PORT} (scan + location-echo forwarder ativo)`,
  );
});
