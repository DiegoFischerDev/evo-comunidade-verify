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

/** Apenas dígitos (remove @s.whatsapp.net, +, espaços, etc.). */
function digitsOnly(value) {
  return String(value || '').replace(/\D+/g, '');
}

/** Envia a mensagem ao backend; tenta URL principal e fallback. Best-effort. */
async function forwardToBackend(payload) {
  const targets = [COMMUNITY_API_URL, COMMUNITY_API_URL_FALLBACK].filter(Boolean);
  if (!targets.length || !COMMUNITY_INTERNAL_SECRET) {
    if (LOG_WEBHOOK) {
      console.log('[wa-verify] scan: backend não configurado (COMMUNITY_API_URL/SECRET)');
    }
    return;
  }
  for (const base of targets) {
    try {
      const res = await fetch(`${base}/whatsapp-scan/ingest`, {
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
          console.log('[wa-verify] scan forwarded', body && body.status);
        }
        return;
      }
      if (LOG_WEBHOOK) {
        console.log('[wa-verify] scan backend respondeu', res.status, 'em', base);
      }
    } catch (e) {
      if (LOG_WEBHOOK) {
        console.log('[wa-verify] scan erro ao reencaminhar para', base, e && e.message);
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
  const events = extractMessageEvents(body);
  for (const item of events) {
    try {
      const key = item && item.key ? item.key : {};
      const remoteJid = String(key.remoteJid || '');
      // Só processamos mensagens de GRUPO e que não foram enviadas por nós.
      if (!remoteJid.endsWith('@g.us')) continue;
      if (key.fromMe === true) continue;

      // Em grupos, o autor real está em `participant`.
      const senderNumber = digitsOnly(key.participant || remoteJid);
      const externalMessageId = key.id ? String(key.id) : undefined;

      // Mídia com bytes (Webhook Base64): reencaminha como imagem/vídeo (com legenda).
      const media = extractMedia(item.message);
      if (media && media.base64) {
        await forwardToBackend({
          groupJid: remoteJid,
          senderNumber,
          kind: media.kind,
          base64: media.base64,
          mimeType: media.mimeType,
          fileName: media.fileName,
          text: String(media.caption || '').slice(0, 8000),
          externalMessageId,
        });
        continue;
      }

      // Texto (ou legenda sem bytes de mídia disponíveis).
      const text = extractMessageText(item.message);
      if (!text || !text.trim()) continue;

      await forwardToBackend({
        groupJid: remoteJid,
        senderNumber,
        kind: 'text',
        text: String(text).slice(0, 8000),
        externalMessageId,
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
  return res.json({ ok: true });
}

app.post(/^\/webhook\/evolution(\/.*)?$/, evolutionWebhookHandler);

app.listen(PORT, () => {
  console.log(`[wa-verify] listening on :${PORT} (whatsapp-scan forwarder ativo)`);
});
