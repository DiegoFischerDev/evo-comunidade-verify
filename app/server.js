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

const FINANCING_QUIZ_TRIGGER = normalizeText(
  'Ola, quero saber se consigo financiar uma casa em Portugal',
);

const QUIZ_STATE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {{
 *   step: 'AWAIT_MARITAL' | 'AWAIT_Q2' | 'AWAIT_Q3' | 'AWAIT_Q4' | 'AWAIT_Q5',
 *   mode: 'casado' | 'solteiro' | null,
 *   answers: { q2?: 'SIM' | 'NAO'; q3?: 'SIM' | 'NAO'; q4?: 'SIM' | 'NAO'; q5?: 'SIM' | 'NAO' },
 *   displayFirstName: string,
 *   fullPushName: string,
 *   updatedAt: number,
 * }} CreditQuizState
 */

/** @type {Map<string, CreditQuizState>} */
const creditQuizStates = new Map();

/** Evolution costuma enviar 2 pedidos HTTP em paralelo para o mesmo evento — evita abertura/respostas duplicadas. */
const financingStartExclusive = new Set();
const financingQuizReplyExclusive = new Set();
const createAccountExclusive = new Set();

function getCreditQuizState(whatsappDigits) {
  const s = creditQuizStates.get(whatsappDigits);
  if (!s) return null;
  if (Date.now() - s.updatedAt > QUIZ_STATE_TTL_MS) {
    creditQuizStates.delete(whatsappDigits);
    return null;
  }
  return s;
}

/** @param {string} whatsappDigits @param {CreditQuizState} state */
function setCreditQuizState(whatsappDigits, state) {
  state.updatedAt = Date.now();
  creditQuizStates.set(whatsappDigits, state);
}

function clearCreditQuizState(whatsappDigits) {
  creditQuizStates.delete(whatsappDigits);
}

function firstNameFromPushName(pushName) {
  const raw = String(pushName || '').trim();
  if (!raw) return 'amigo';
  const first = raw.split(/\s+/)[0];
  if (!first) return 'amigo';
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

function parseMaritalStatus(text) {
  const n = normalizeText(text);
  if (['casado', 'casada'].includes(n)) return 'casado';
  if (['solteiro', 'solteira'].includes(n)) return 'solteiro';
  return null;
}

/** SIM/NAO: `normalizeText` remove acentos (ex.: não→nao, sim→sim). Só uma palavra; pontuação à volta é ignorada. */
function parseSimNao(text) {
  const raw = normalizeText(text).replace(/^[^a-z]+|[^a-z]+$/g, '');
  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  if (words.length === 1) {
    if (words[0] === 'sim') return 'SIM';
    if (words[0] === 'nao') return 'NAO';
    if (words[0] === 's') return 'SIM';
    if (words[0] === 'n') return 'NAO';
    return null;
  }
  return null;
}

/** @param {'casado' | 'solteiro'} mode @param {2|3|4|5} n */
function financingQuestion(mode, n) {
  if (mode === 'casado') {
    if (n === 2)
      return '2- Pelo menos Um dos dois ja possui cartão cidadão ou título de residência no formato de cartão?\nSIM ou NAO';
    if (n === 3)
      return '3- Pelo menos Um dos dois possui contrato de trabalho efetivo?\nSIM ou NAO';
    if (n === 4)
      return '4- Pelo menos Um dos dois possui declaração de Imposto de renda do ano anterior?\nSIM ou NAO';
    return '5- Ambos tem menos de 35 anos?\nSIM ou NAO';
  }
  if (n === 2)
    return '2- Voce possui cartão cidadão ou título de residência no formato de cartão?\nSIM ou NAO';
  if (n === 3) return '3- Você possui contrato de trabalho efetivo?\nSIM ou NAO';
  if (n === 4)
    return '4- Você possui declaração de imposto de renda do ano anterior?\nSIM ou NAO';
  return '5- Tem menos de 35 anos?\nSIM ou NAO';
}

/**
 * @param {'SIM'|'NAO'} q2
 * @param {'SIM'|'NAO'} q3
 * @param {'SIM'|'NAO'} q4
 * @param {'SIM'|'NAO'} q5
 */
function classifyFinancingAnswers(q2, q3, q4, q5) {
  if (q3 === 'NAO') {
    return {
      key: 'inviavel',
      comment: 'Resultado inviavel',
      body:
        'Resultado Inviavel:\n❌ Infelizmente com recibos verdes ou contrato temporário fica muito difícil conseguir aprovação de credito. Talvez ainda nao seja o momento de tentar. Ter um contrato de trabalho efetivo é o principal fator para aprovação dos créditos.',
    };
  }
  if (q2 === 'SIM' && q3 === 'SIM' && q4 === 'SIM' && q5 === 'SIM') {
    return {
      key: '100',
      comment: 'Resultado 100%',
      body:
        'Resultado 100%:\n✅ Em termos gerais, voce possui viabilidade para aprovaçao de financiamento de 100% do valor da casa!',
    };
  }
  if (q2 === 'NAO' && q3 === 'SIM' && q4 === 'SIM') {
    return {
      key: '80',
      comment: 'Resultado 80%',
      body:
        'Resultado 80%:\n✅ Em termos gerais, voce possui viabilidade para aprovaçao de financiamento de 80% do valor da casa. Você pode financiar como investidor estrangeiro. Nesse caso você teria que dar 20% de entrada com capitais próprios',
    };
  }
  if (q4 === 'NAO' && q2 === 'SIM' && q3 === 'SIM' && q5 === 'SIM') {
    return {
      key: 'indef100',
      comment: 'Resultado possível 100%',
      body:
        'Resultado Indefinido:\n✅ Em termos gerais seu caso é dificil por conta de nao ter o IRs ainda, mas vale a pena tentar. Quando tiver o IRs voce pode conseguir ate uma aprovação de 100%!',
    };
  }
  if (q4 === 'NAO' && q2 === 'SIM' && q3 === 'SIM') {
    return {
      key: 'indef90',
      comment: 'Resultado possível 90%',
      body:
        'Resultado Indefinido:\n✅ Em termos gerais seu caso é dificil por conta de nao ter o IRs ainda, mas vale a pena tentar. Quando tiver o IRs voce pode conseguir uma aprovação de 90% do valor da casa. E ai você teria que dar 10% de entrada com capitais próprios.',
    };
  }
  if (q2 === 'SIM' && q3 === 'SIM' && q4 === 'SIM' && q5 === 'NAO') {
    return {
      key: '90',
      comment: 'Resultado 90%',
      body:
        'Resultado 90%:\n✅ Em termos gerais, voce possui viabilidade para aprovaçao de financiamento de 90% do valor da casa. E ai você teria que dar 10% de entrada com capitais próprios.',
    };
  }
  return {
    key: 'fallback',
    comment: 'Resultado possível 90%',
    body:
      'Resultado Indefinido:\n✅ Em termos gerais seu caso tem particularidades. Vale a pena tentar e falar com um gestor de crédito para analisar o seu caso em detalhe.',
  };
}

const FINANCING_FOLLOWUP_MESSAGES = [
  'Se fizer sentido e quiser avançar com o seu processo, nos indicamos iniciar analise gratuita especifica do seu caso com um gestor de credito. Voce envia os documentos necessários para ele e ele vai levar esses documentos para todos os bancos afim de conseguir uma pré-aprovação. Com a pre-aprovação em mãos, voce ja pode começar a procurar e visitar as casas. Para receber o contato do gestor de credito que indicamos bem como a lista de documentos necessários, pedimos que confirme seu email no link a seguir:',
  null,
  'Voce pode usar esse link para enviar os documentos para iniciar sua analise gratuita com o seu gestor.',
  'No mais, te recomendamos acompanhar nosso canal no YouTube onde contamos sobre o nosso processo:',
  'https://www.youtube.com/watch?v=nSuXTX0z9Vk&t=106s',
  'https://www.youtube.com/watch?v=v04RVqeT9aQ&t=30s',
  'Em breve vamos lançar um ebook com todas as dicas para conseguir credito e casa em Portugal, bem como um grupo no WhatsApp e lives com gestores de credito todos os domingos!',
  'Infelizmente por aqui nao consigo atender todo mundo, mas se precisar falar comigo, deixa uma mensagem no Instagram que assim que eu ver eu te respondo.',
  'Um xero e boa sorte! Rafa',
];

async function startFinancingQuiz(whatsappDigits, pushName) {
  const displayFirstName = firstNameFromPushName(pushName);
  const fullPushName = String(pushName || '').trim() || displayFirstName;
  setCreditQuizState(whatsappDigits, {
    step: 'AWAIT_MARITAL',
    mode: null,
    answers: {},
    displayFirstName,
    fullPushName,
    updatedAt: Date.now(),
  });
  await sendEvolutionText(whatsappDigits, `Oi ${displayFirstName} tudo bem?`);
  await sleep(1200);
  await sendEvolutionText(
    whatsappDigits,
    'Vou te fazer 5 perguntas e no final vou te falar em termos gerais se você consegue financiar uma casa em Portugal ok?',
  );
  await sleep(1200);
  await sendEvolutionText(whatsappDigits, '1- Voce é CASADO ou SOLTEIRO?');
}

/**
 * @param {string} whatsappDigits
 * @param {string} trimmed
 * @param {string} [pushName]
 * @returns {Promise<boolean>} true se consumiu a mensagem (não bufferizar código)
 */
async function tryHandleFinancingQuiz(whatsappDigits, trimmed, pushName) {
  const state = getCreditQuizState(whatsappDigits);
  if (!state) return false;

  if (financingQuizReplyExclusive.has(whatsappDigits)) {
    console.log('[wa-verify] financing-quiz: ignorado (processamento em curso)', { whatsapp: whatsappDigits });
    return true;
  }
  financingQuizReplyExclusive.add(whatsappDigits);

  try {
    if (state.step === 'AWAIT_MARITAL') {
      const marital = parseMaritalStatus(trimmed);
      if (!marital) {
        await sendEvolutionText(
          whatsappDigits,
          'Nao entendi. Por favor responda com uma destas opções: CASADO, CASADA, SOLTEIRO ou SOLTEIRA.',
        );
        await sleep(800);
        await sendEvolutionText(whatsappDigits, '1- Voce é CASADO ou SOLTEIRO?');
        setCreditQuizState(whatsappDigits, state);
        return true;
      }
      state.mode = marital;
      state.step = 'AWAIT_Q2';
      if (pushName && String(pushName).trim()) state.fullPushName = String(pushName).trim();
      setCreditQuizState(whatsappDigits, state);
      await sendEvolutionText(whatsappDigits, financingQuestion(state.mode, 2));
      return true;
    }

    const stepToNum = { AWAIT_Q2: 2, AWAIT_Q3: 3, AWAIT_Q4: 4, AWAIT_Q5: 5 };
    const stepKey = state.step;
    if (!(stepKey in stepToNum)) return false;
    const num = stepToNum[/** @type {'AWAIT_Q2'|'AWAIT_Q3'|'AWAIT_Q4'|'AWAIT_Q5'} */ (stepKey)];
    const ans = parseSimNao(trimmed);
    if (!ans) {
      await sendEvolutionText(
        whatsappDigits,
        'Nao entendi. Por favor responda apenas com SIM ou NAO.',
      );
      await sleep(800);
      await sendEvolutionText(
        whatsappDigits,
        financingQuestion(/** @type {'casado'|'solteiro'} */ (state.mode), num),
      );
      setCreditQuizState(whatsappDigits, state);
      return true;
    }

    if (num === 2) state.answers.q2 = ans;
    else if (num === 3) state.answers.q3 = ans;
    else if (num === 4) state.answers.q4 = ans;
    else state.answers.q5 = ans;

    if (num < 5) {
      const next = /** @type {'AWAIT_Q2'|'AWAIT_Q3'|'AWAIT_Q4'|'AWAIT_Q5'} */ (
        num === 2 ? 'AWAIT_Q3' : num === 3 ? 'AWAIT_Q4' : 'AWAIT_Q5'
      );
      state.step = next;
      setCreditQuizState(whatsappDigits, state);
      await sendEvolutionText(whatsappDigits, financingQuestion(state.mode, num + 1));
      return true;
    }

    const { q2, q3, q4, q5 } = state.answers;
    if (!q2 || !q3 || !q4 || !state.answers.q5) {
      clearCreditQuizState(whatsappDigits);
      return true;
    }
    const outcome = classifyFinancingAnswers(q2, q3, q4, state.answers.q5);
    await sendEvolutionText(whatsappDigits, outcome.body);
    await sleep(1200);

    const nomeLead = state.fullPushName || state.displayFirstName || 'Cliente WhatsApp';
    try {
      const data = await createIaAppLead(whatsappDigits, nomeLead, {
        comentario: outcome.comment,
      });
      for (let i = 0; i < FINANCING_FOLLOWUP_MESSAGES.length; i++) {
        const line = FINANCING_FOLLOWUP_MESSAGES[i];
        if (line === null) {
          await sendEvolutionText(whatsappDigits, String(data.upload_url));
        } else {
          await sendEvolutionText(whatsappDigits, line);
        }
        await sleep(1200);
      }
    } catch (err) {
      const detail = err?.message || String(err);
      console.warn('[wa-verify] financing-quiz: lead falhou', { whatsapp: whatsappDigits, detail });
      await sendEvolutionText(whatsappDigits, 'Erro ao registar o teu contacto. Tenta mais tarde ou escreve criar conta.');
      await sleep(800);
      await sendEvolutionText(whatsappDigits, detail);
    }
    clearCreditQuizState(whatsappDigits);
    return true;
  } finally {
    financingQuizReplyExclusive.delete(whatsappDigits);
  }
}

/**
 * @param {string} whatsappDigits
 * @param {string} nome
 * @param {{ comentario?: string }} [options]
 * @returns {Promise<{ ok: true, id: number, upload_url: string, existing?: boolean, lead?: unknown }>}
 */
async function createIaAppLead(whatsappDigits, nome, options = {}) {
  const base = (process.env.IA_APP_BASE_URL || 'https://ia.rafaapelomundo.com/').replace(/\/$/, '');
  const secret = process.env.IA_APP_INTEGRATION_SECRET || '';
  if (!secret) {
    throw new Error('Integração não configurada no servidor.');
  }
  const body = {
    whatsapp: whatsappDigits,
    nome: nome || 'Cliente WhatsApp',
  };
  const c = String(options.comentario || '').trim();
  if (c) body.comentario = c;

  const res = await fetch(`${base}/api/integration/leads`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Integration-Secret': secret,
    },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let json = {};
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    json = {};
  }
  const okLead =
    (res.status === 201 || res.status === 200) &&
    json.ok === true &&
    typeof json.upload_url === 'string' &&
    json.upload_url;
  if (okLead) {
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
  const nome = String(contactName || '').trim() || 'Cliente WhatsApp';

  try {
    const data = await createIaAppLead(whatsappDigits, nome);
    console.log('[wa-verify] create-account: ok', {
      whatsapp: whatsappDigits,
      id: data.id,
      existing: data.existing === true,
    });
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
 * O mesmo evento pode repetir a mensagem em `data.key` e em `data.messages` — deduplicamos.
 */
function listIncomingMessageParts(body) {
  /** @type {{ remoteJid: string, fromMe?: boolean, text: string, pushName?: string, msgId?: string }[]} */
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
    const msgId = key.id != null && key.id !== '' ? String(key.id) : '';
    parts.push({ remoteJid: jid, fromMe: key.fromMe, text, pushName, msgId });
  };

  if (d.key && d.message) {
    push(d.key, d.message, d.pushName);
  }

  let raw = d.messages;
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  for (const item of list) {
    if (item?.key && item?.message) push(item.key, item.message, item.pushName || d.pushName);
  }

  return dedupeMessageParts(parts);
}

/**
 * Mesma mensagem costuma vir em `data.key` e outra vez em `data.messages` — por vezes só uma das
 * entradas traz `key.id`. Chave estável: JID + texto normalizado (quando há texto).
 * @param {{ remoteJid: string, fromMe?: boolean, text: string, pushName?: string, msgId?: string }[]} parts
 */
function dedupeMessageParts(parts) {
  /** @type {Map<string, { remoteJid: string, fromMe?: boolean, text: string, pushName?: string, msgId?: string }>} */
  const byKey = new Map();
  for (const p of parts) {
    const jid = p.remoteJid;
    const textNorm = normalizeText(p.text);
    let dedupeKey;
    if (textNorm.length > 0) {
      dedupeKey = `${jid}|t:${textNorm}`;
    } else if (p.msgId && String(p.msgId).length > 0) {
      dedupeKey = `${jid}|id:${p.msgId}`;
    } else {
      continue;
    }
    const prev = byKey.get(dedupeKey);
    if (!prev) {
      byKey.set(dedupeKey, p);
      continue;
    }
    byKey.set(dedupeKey, {
      ...prev,
      msgId: prev.msgId || p.msgId,
      pushName:
        (prev.pushName && prev.pushName.length >= (p.pushName || '').length) ? prev.pushName : p.pushName,
    });
  }
  return [...byKey.values()];
}

/**
 * Última linha de defesa no mesmo pedido HTTP: mesmo JID (dígitos) + mesmo texto.
 * @param {{ remoteJid: string, fromMe?: boolean, text: string, pushName?: string, msgId?: string }[]} parts
 */
function dedupeWebhookPartsForLoop(parts) {
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const wa = normalizeWhatsappFromJid(p.remoteJid);
    if (!wa) continue;
    const key = `${wa}|${normalizeText(p.text)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
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

    const parts = dedupeWebhookPartsForLoop(listIncomingMessageParts(req.body));
    let anyBuffered = false;
    for (const { remoteJid, text, pushName } of parts) {
      const whatsapp = normalizeWhatsappFromJid(remoteJid);
      if (!whatsapp) continue;
      const trimmed = text && String(text).trim();
      if (!trimmed) continue;

      // Gatilhos globais (reiniciam / cancelam quiz de financiamento em curso)
      if (normalizeText(trimmed) === FINANCING_QUIZ_TRIGGER) {
        if (financingStartExclusive.has(whatsapp)) {
          console.log('[wa-verify] financing-quiz: abertura duplicada ignorada', { whatsapp });
          anyBuffered = true;
          continue;
        }
        financingStartExclusive.add(whatsapp);
        try {
          clearCreditQuizState(whatsapp);
          await startFinancingQuiz(whatsapp, pushName || '');
        } catch (err) {
          console.warn('[wa-verify] financing-quiz: erro ao iniciar', err?.message || err);
        } finally {
          financingStartExclusive.delete(whatsapp);
        }
        anyBuffered = true;
        continue;
      }

      if (normalizeText(trimmed) === CREDIT_HELP_TRIGGER) {
        clearCreditQuizState(whatsapp);
        sendCreditHelpFlow({ whatsappDigits: whatsapp, contactName: pushName }).catch((err) => {
          console.warn('[wa-verify] credit-help: erro ao enviar flow:', err?.message || err);
        });
        anyBuffered = true;
        continue;
      }

      if (normalizeText(trimmed) === CREATE_ACCOUNT_TRIGGER) {
        clearCreditQuizState(whatsapp);
        if (createAccountExclusive.has(whatsapp)) {
          anyBuffered = true;
          continue;
        }
        createAccountExclusive.add(whatsapp);
        sendCreateAccountFlow({ whatsappDigits: whatsapp, contactName: pushName })
          .catch((err) => {
            console.warn('[wa-verify] create-account: exceção:', err?.message || err);
          })
          .finally(() => createAccountExclusive.delete(whatsapp));
        anyBuffered = true;
        continue;
      }

      if (getCreditQuizState(whatsapp)) {
        const consumed = await tryHandleFinancingQuiz(whatsapp, trimmed, pushName || '');
        if (consumed) {
          anyBuffered = true;
          continue;
        }
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
