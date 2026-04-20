const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const app = express();
// Evolution envia payloads grandes (mensagens, metadados, mídia em base64); 1mb causava 413 no Nginx/Express
app.use(express.json({ limit: '25mb' }));

const PORT = process.env.PORT || 3100;

// Segurança: valida que a chamada do webhook veio de quem tem o segredo
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

// Chamada interna para o backend da Comunidade
const COMMUNITY_API_URL = (process.env.COMMUNITY_API_URL || '').replace(/\/$/, '');
// Fallback (ex.: validar código também no stage quando o utilizador gerou no ambiente errado)
const COMMUNITY_API_URL_FALLBACK = (process.env.COMMUNITY_API_URL_FALLBACK || '').replace(/\/$/, '');
const COMMUNITY_INTERNAL_SECRET = process.env.COMMUNITY_INTERNAL_SECRET || '';

// Envio de mensagens via Evolution (resposta automática de teste)
const EVOLUTION_API_URL = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, '');
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || 'comunidade';
const EVOLUTION_INSTANCE_SECONDARY = process.env.EVOLUTION_INSTANCE_SECONDARY || '';

function parseCsvSet(raw) {
  return new Set(
    String(raw || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

const CHATBOT_ALLOWED_INSTANCES = parseCsvSet(
  process.env.EVOLUTION_CHATBOT_INSTANCES ||
    [EVOLUTION_INSTANCE, EVOLUTION_INSTANCE_SECONDARY].filter(Boolean).join(','),
);

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

/** Links / pré-visualizações podem enviar o texto em percent-encoding (ex.: Ol%C3%A1%2C%20quero...). */
function maybeUrlDecodeInboundText(text) {
  const t = String(text || '').trim();
  if (!t.includes('%')) return t;
  try {
    return decodeURIComponent(t.replace(/\+/g, ' '));
  } catch {
    return t;
  }
}

const CREDIT_HELP_TRIGGER = normalizeText('Ola, preciso de ajuda em relação ao contato da gestora de crédito');

const CREATE_ACCOUNT_TRIGGER = normalizeText('criar conta');
const WANT_HOUSE_TRIGGER = normalizeText('quero casa');

const FINANCING_QUIZ_TRIGGERS = new Set([
  normalizeText('Ola, quero saber se consigo financiar uma casa em Portugal'),
  normalizeText('Oi, quero saber se consigo financiar uma casa em Portugal'),
  // Atalho para refazer o questionário (normalizeText remove acentos)
  normalizeText('questionario'),
  normalizeText('questionário'),
]);

const QUIZ_STATE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {{
 *   step: 'AWAIT_MARITAL' | 'AWAIT_Q2' | 'AWAIT_Q3' | 'AWAIT_Q7' | 'AWAIT_Q4' | 'AWAIT_Q5' | 'AWAIT_CAPITALS',
 *   mode: 'casado' | 'solteiro' | null,
 *   answers: { q2?: 'SIM' | 'NAO'; q3?: 'SIM' | 'NAO'; q7?: 'SIM' | 'NAO'; q4?: 'SIM' | 'NAO'; q5?: 'SIM' | 'NAO'; capitalOk?: 'SIM' | 'NAO'; capitalPercent?: 10 | 20 },
 *   displayFirstName: string,
 *   fullPushName: string,
 *   pendingCapitalPercent?: 10 | 20,
 *   updatedAt: number,
 * }} CreditQuizState
 */

/** @type {Map<string, CreditQuizState>} */
const creditQuizStates = new Map();

/**
 * Evolution costuma reemitir o mesmo `messages.upsert` (vários POSTs ou payload duplicado).
 * Cada mensagem de entrada tem um `key.id` estável no Baileys — ignoramos o 2º processamento do mesmo id.
 */
const SEEN_MSG_ID_TTL_MS = Number(process.env.WA_SEEN_MSG_ID_TTL_MS || 15 * 60 * 1000);
/** @type {Map<string, number>} */
const seenInboundMessageIds = new Map();

/** Mapeia último número -> instância de origem para responder no mesmo WhatsApp. */
const lastInboundInstanceByWhatsapp = new Map();

/**
 * @param {string | undefined} msgId
 * @returns {boolean} true = processar; false = já processámos este id (duplicata Evolution)
 */
function claimInboundMessageOnce(msgId) {
  const id = msgId != null && String(msgId).trim() !== '' ? String(msgId).trim() : '';
  if (!id) return true;

  const now = Date.now();
  if (seenInboundMessageIds.size > 8000) {
    for (const [k, t] of seenInboundMessageIds) {
      if (now - t > SEEN_MSG_ID_TTL_MS) seenInboundMessageIds.delete(k);
    }
  }

  const prev = seenInboundMessageIds.get(id);
  if (prev !== undefined && now - prev < SEEN_MSG_ID_TTL_MS) {
    console.log('[wa-verify] skip duplicate Baileys message id (Evolution)', { id: id.slice(0, 28) });
    return false;
  }
  seenInboundMessageIds.set(id, now);
  return true;
}

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
      return '2- Pelo menos um dos dois já possui cartão de cidadão ou título de residência no formato de cartão?\nSIM ou NÃO';
    if (n === 3)
      return '3- Pelo menos um dos dois possui contrato de trabalho efetivo?\nSIM ou NÃO';
    if (n === 4)
      return '4- Pelo menos um dos dois possui declaração de imposto de renda do ano anterior?\nSIM ou NÃO';
    return '5- Ambos têm menos de 35 anos?\nSIM ou NÃO';
  }
  if (n === 2)
    return '2- Você possui cartão de cidadão ou título de residência no formato de cartão?\nSIM ou NÃO';
  if (n === 3) return '3- Você possui contrato de trabalho efetivo?\nSIM ou NÃO';
  if (n === 4)
    return '4- Você possui declaração de imposto de renda do ano anterior?\nSIM ou NÃO';
  return '5- Tem menos de 35 anos?\nSIM ou NÃO';
}

/** Pergunta extra quando a resposta à 3 é NÃO (sem contrato de trabalho efetivo). */
function financingQuestionSeven(mode) {
  if (mode === 'casado') {
    return '7- Por não haver contrato de trabalho efetivo, o caso torna-se um pouco mais complexo. Teriam 10% em capitais próprios para dar de entrada?\nSIM ou NÃO';
  }
  return '7- Por não ter contrato de trabalho efetivo, o seu caso torna-se um pouco mais complexo. Teria 10% em capitais próprios para dar de entrada?\nSIM ou NÃO';
}

/** Pergunta extra quando é necessária entrada (capitais próprios). */
function financingCapitalQuestion(mode, percent) {
  const p = percent === 20 ? '20%' : '10%';
  if (mode === 'casado') {
    return `6- Vocês teriam ${p} do valor da casa em capitais próprios para dar de entrada?\nSIM ou NÃO`;
  }
  return `6- Você teria ${p} do valor da casa em capitais próprios para dar de entrada?\nSIM ou NÃO`;
}

function computeRequiredCapitalPercent(q2, q3, q4, q5) {
  // Investidor estrangeiro (sem AR/CC): normalmente exige 20% de entrada
  if (q2 === 'NAO' && q3 === 'SIM' && q4 === 'SIM') return 20;
  // Casos com 10% de entrada (resultado 90% ou indefinido 90% por falta de IRS)
  if (q2 === 'SIM' && q3 === 'SIM' && q4 === 'SIM' && q5 === 'NAO') return 10;
  if (q4 === 'NAO' && q2 === 'SIM' && q3 === 'SIM') return 10;
  return null;
}

function buildQuizSummary(state) {
  const a = state.answers || {};
  const modeLabel = state.mode === 'casado' ? 'Casado' : state.mode === 'solteiro' ? 'Solteiro' : 'Indefinido';
  const parts = [modeLabel];
  if (a.q2) parts.push(a.q2 === 'SIM' ? 'tem AR/CC' : 'não tem AR/CC');
  if (a.q3) parts.push(a.q3 === 'SIM' ? 'tem CTEF' : 'não tem CTEF');
  if (a.q4) parts.push(a.q4 === 'SIM' ? 'tem IRS' : 'não tem IRS');
  if (a.q5) parts.push(a.q5 === 'SIM' ? 'menos de 35 anos' : '35+ anos');
  if (a.capitalPercent) parts.push(`tem ${a.capitalPercent}%`);
  return parts.join(', ');
}

/**
 * @param {'SIM'|'NAO'} q2
 * @param {'SIM'|'NAO'} q3
 * @param {'SIM'|'NAO'} q4
 * @param {'SIM'|'NAO'} q5
 * @param {'SIM'|'NAO'|undefined} q7 só preenchido quando q3 é NÃO (pergunta 7)
 */
function classifyFinancingAnswers(q2, q3, q4, q5, q7) {
  if (q3 === 'NAO' && q7 !== 'SIM') {
    return {
      key: 'inviavel',
      comment: 'Sem viabilidade identificada no questionário',
      body:
        'Resultado inviável:\n❌ Infelizmente com recibos verdes ou contrato temporário fica muito difícil conseguir aprovação de crédito. Talvez ainda não seja o momento de tentar. Ter um contrato de trabalho efetivo é o principal fator para a aprovação dos créditos.',
    };
  }
  if (q3 === 'NAO' && q7 === 'SIM') {
    return {
      key: 'indef-sem-ctef-10',
      comment: 'Possível viabilidade a confirmar (sem CTEF, com ~10% de entrada)',
      body:
        'Resultado indefinido:\n✅ Sem contrato de trabalho efetivo, os bancos tendem a ser mais exigentes; ao indicar que dispõe de cerca de 10% em capitais próprios para entrada, o seu caso deixa de ser automaticamente inviável e pode haver margem para analisar soluções com um gestor de crédito. Não é garantia de aprovação, mas vale reunir a documentação e pedir uma avaliação personalizada.',
    };
  }
  if (q2 === 'SIM' && q3 === 'SIM' && q4 === 'SIM' && q5 === 'SIM') {
    return {
      key: '100',
      comment: 'Possível viabilidade de 100%',
      body:
        'Resultado 100%:\n✅ Em termos gerais, você tem viabilidade para aprovação de financiamento de 100% do valor da casa!',
    };
  }
  if (q2 === 'NAO' && q3 === 'SIM' && q4 === 'SIM') {
    return {
      key: '80',
      comment: 'Possível viabilidade de 80%',
      body:
        'Resultado 80%:\n✅ Em termos gerais, você tem viabilidade para aprovação de financiamento de 80% do valor da casa. Você pode financiar como investidor estrangeiro. Nesse caso teria de dar 20% de entrada com capitais próprios.',
    };
  }
  if (q4 === 'NAO' && q2 === 'SIM' && q3 === 'SIM' && q5 === 'SIM') {
    return {
      key: 'indef100',
      comment: 'Possível viabilidade até 100% (a confirmar)',
      body:
        'Resultado viável (a confirmar):\n✅ Pelo facto de ter contrato de trabalho efetivo, o seu caso é viável para avançar com a análise.\n\n⚠️ No momento, por ainda não ter o IRS do ano anterior, a aprovação pode ficar mais difícil (e alguns bancos podem pedir que aguarde), mas você deve seguir avançando com o processo.\n\nAssim que tiver o IRS, envie para a gestora de crédito para reforçar o seu processo.\n\nVou enviar o link da gestora a seguir.',
    };
  }
  if (q4 === 'NAO' && q2 === 'SIM' && q3 === 'SIM') {
    return {
      key: 'indef90',
      comment: 'Possível viabilidade de 90% (a confirmar)',
      body:
        'Resultado viável (a confirmar):\n✅ Pelo facto de ter contrato de trabalho efetivo, o seu caso é viável para avançar com a análise.\n\n⚠️ No momento, por ainda não ter o IRS do ano anterior, a aprovação pode ficar mais difícil (e alguns bancos podem pedir que aguarde), mas você deve seguir avançando com o processo.\n\nAssim que tiver o IRS, envie para a gestora de crédito para reforçar o seu processo.\n\nQuando tiver o IRS, pode conseguir uma aprovação de 90% do valor da casa (com 10% de entrada em capitais próprios).\n\nVou enviar o link da gestora a seguir.',
    };
  }
  if (q2 === 'SIM' && q3 === 'SIM' && q4 === 'SIM' && q5 === 'NAO') {
    return {
      key: '90',
      comment: 'Possível viabilidade de 90%',
      body:
        'Resultado 90%:\n✅ Em termos gerais, você tem viabilidade para aprovação de financiamento de 90% do valor da casa. E aí teria de dar 10% de entrada com capitais próprios.',
    };
  }
  return {
    key: 'fallback',
    comment: 'Possível viabilidade a confirmar (caso com particularidades)',
    body:
      'Resultado indefinido:\n✅ Em termos gerais o seu caso tem particularidades. Vale a pena tentar e falar com um gestor de crédito para analisar o seu caso em detalhe.',
  };
}

const FINANCING_INVIABLE_RETRY_MESSAGE =
  'Se as condições mudarem e quiser responder ao questionário novamente e avançar com o processo, digite QUESTIONARIO e iniciamos outra análise.';

const ATENDIMENTO_TRIGGER = normalizeText('atendimento');
const ATENDIMENTO_PROMPT_TTL_MS = 24 * 60 * 60 * 1000;

/** @type {Map<string, { uploadUrl: string, contactName: string, quizSummary: string, updatedAt: number }>} */
const atendimentoPromptStates = new Map();

function getAtendimentoPromptState(whatsappDigits) {
  const s = atendimentoPromptStates.get(whatsappDigits);
  if (!s) return null;
  if (Date.now() - s.updatedAt > ATENDIMENTO_PROMPT_TTL_MS) {
    atendimentoPromptStates.delete(whatsappDigits);
    return null;
  }
  return s;
}

function setAtendimentoPromptState(whatsappDigits, state) {
  atendimentoPromptStates.set(whatsappDigits, {
    ...state,
    updatedAt: Date.now(),
  });
}

function clearAtendimentoPromptState(whatsappDigits) {
  atendimentoPromptStates.delete(whatsappDigits);
}

async function startFinancingQuiz(whatsappDigits, pushName) {
  const displayFirstName = firstNameFromPushName(pushName);
  const fullPushName = String(pushName || '').trim() || displayFirstName;
  setCreditQuizState(whatsappDigits, {
    step: 'AWAIT_MARITAL',
    mode: null,
    answers: {},
    displayFirstName,
    fullPushName,
    pendingCapitalPercent: undefined,
    updatedAt: Date.now(),
  });

  // Cria (ou reutiliza) o lead assim que o utilizador inicia o questionário.
  createIaAppLead(whatsappDigits, fullPushName).catch(
    (err) => {
      console.warn(
        '[wa-verify] financing-quiz: falha ao criar lead no início',
        err?.message || err,
      );
    },
  );

  await sendEvolutionText(whatsappDigits, `Oi ${displayFirstName} tudo bem?`);
  await sleep(1200);
  await sendEvolutionText(
    whatsappDigits,
    'Vou fazer-lhe algumas perguntas e, no final, digo-lhe em termos gerais se consegue financiar uma casa em Portugal, ok?',
  );
  await sleep(1200);
  await sendEvolutionText(
    whatsappDigits,
    '1- Você é CASADO ou SOLTEIRO? (Em união de facto, responda como CASADO.)',
  );
}

/**
 * Envia resultado do quiz, cria lead na API e inicia decisão de atendimento.
 * @param {string} whatsappDigits
 * @param {CreditQuizState} state
 * @param {{ key: string, comment: string, body: string }} outcome
 */
async function finishFinancingQuizWithOutcome(whatsappDigits, state, outcome) {
  await sendEvolutionText(whatsappDigits, outcome.body);
  await sleep(1200);

  const summary = buildQuizSummary(state);
  const comentario = summary;
  const comentarioAppend = `Quiz financiamento (${new Date().toISOString().slice(0, 10)}): ${outcome.comment}. Respostas: ${summary}`;

  const nomeLead = state.fullPushName || state.displayFirstName || 'Cliente WhatsApp';
  try {
    const data = await createIaAppLead(whatsappDigits, nomeLead, {
      comentario,
    });
    try {
      await patchIaAppLeadComment(whatsappDigits, comentarioAppend);
    } catch (err) {
      console.warn(
        '[wa-verify] financing-quiz: falha ao atualizar comentário do lead',
        err?.message || err,
      );
    }
    if (outcome.key === 'inviavel') {
      await sendEvolutionText(whatsappDigits, FINANCING_INVIABLE_RETRY_MESSAGE);
      clearCreditQuizState(whatsappDigits);
      return;
    }
    const uploadUrl = String(data.upload_url || '').trim();
    setAtendimentoPromptState(whatsappDigits, {
      uploadUrl,
      contactName: nomeLead,
      quizSummary: summary,
      updatedAt: Date.now(),
    });
    await sendEvolutionText(
      whatsappDigits,
      'Deseja que o gestor(a) de crédito entre em contacto com você para atendimento e dar continuidade ao seu processo? Responda SIM ou NÃO.',
    );
    clearCreditQuizState(whatsappDigits);
  } catch (err) {
    const detail = err?.message || String(err);
    console.warn('[wa-verify] financing-quiz: lead falhou', { whatsapp: whatsappDigits, detail });
    await sendEvolutionText(
      whatsappDigits,
      'Erro ao registar o seu contacto. Tente mais tarde ou escreva "criar conta".',
    );
    await sleep(800);
    await sendEvolutionText(whatsappDigits, detail);
    clearCreditQuizState(whatsappDigits);
  }
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

  if (state.step === 'AWAIT_MARITAL') {
    const marital = parseMaritalStatus(trimmed);
    if (!marital) {
      await sendEvolutionText(
        whatsappDigits,
        'Não entendi. Por favor responda com uma destas opções: CASADO, CASADA, SOLTEIRO ou SOLTEIRA.',
      );
      await sleep(800);
      await sendEvolutionText(
        whatsappDigits,
        '1- Você é CASADO ou SOLTEIRO? (Em união de facto, responda como CASADO.)',
      );
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

  if (state.step === 'AWAIT_Q7') {
    const ans7 = parseSimNao(trimmed);
    if (!ans7) {
      await sendEvolutionText(
        whatsappDigits,
        'Não entendi. Por favor responda apenas com SIM ou NÃO.',
      );
      await sleep(800);
      await sendEvolutionText(whatsappDigits, financingQuestionSeven(/** @type {'casado'|'solteiro'} */ (state.mode)));
      setCreditQuizState(whatsappDigits, state);
      return true;
    }
    state.answers.q7 = ans7;
    if (ans7 === 'NAO') {
      const outcome = classifyFinancingAnswers(
        /** @type {'SIM'|'NAO'} */ (state.answers.q2 || 'NAO'),
        'NAO',
        /** @type {'SIM'|'NAO'} */ (state.answers.q4 || 'NAO'),
        /** @type {'SIM'|'NAO'} */ (state.answers.q5 || 'NAO'),
        'NAO',
      );
      await finishFinancingQuizWithOutcome(whatsappDigits, state, outcome);
      return true;
    }
    // Q7=SIM implica que há 10% para entrada
    state.answers.capitalOk = 'SIM';
    state.answers.capitalPercent = 10;
    state.step = 'AWAIT_Q4';
    setCreditQuizState(whatsappDigits, state);
    await sendEvolutionText(whatsappDigits, financingQuestion(/** @type {'casado'|'solteiro'} */ (state.mode), 4));
    return true;
  }

  if (state.step === 'AWAIT_CAPITALS') {
    const ansCap = parseSimNao(trimmed);
    if (!ansCap) {
      await sendEvolutionText(
        whatsappDigits,
        'Não entendi. Por favor responda apenas com SIM ou NÃO.',
      );
      await sleep(800);
      const pct = state.pendingCapitalPercent || 10;
      await sendEvolutionText(
        whatsappDigits,
        financingCapitalQuestion(/** @type {'casado'|'solteiro'} */ (state.mode), pct),
      );
      setCreditQuizState(whatsappDigits, state);
      return true;
    }

    state.answers.capitalOk = ansCap;
    const pct = state.pendingCapitalPercent || 10;
    if (ansCap === 'SIM') state.answers.capitalPercent = pct;
    state.pendingCapitalPercent = undefined;

    if (ansCap === 'NAO') {
      const outcome = {
        key: 'inviavel',
        comment: 'Sem viabilidade identificada no questionário',
        body:
          'Resultado inviável:\n❌ Sem capitais próprios para a entrada (10% ou 20%, conforme o caso), fica muito difícil conseguir aprovação de crédito.',
      };
      await finishFinancingQuizWithOutcome(whatsappDigits, state, outcome);
      return true;
    }

    const { q2, q3, q4, q5 } = state.answers;
    if (!q2 || !q3 || !q4 || !q5) {
      clearCreditQuizState(whatsappDigits);
      return true;
    }
    const outcome = classifyFinancingAnswers(q2, q3, q4, q5, state.answers.q7);
    await finishFinancingQuizWithOutcome(whatsappDigits, state, outcome);
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
      'Não entendi. Por favor responda apenas com SIM ou NÃO.',
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
    if (num === 3 && ans === 'NAO') {
      state.step = 'AWAIT_Q7';
      setCreditQuizState(whatsappDigits, state);
      await sendEvolutionText(
        whatsappDigits,
        financingQuestionSeven(/** @type {'casado'|'solteiro'} */ (state.mode)),
      );
      return true;
    }
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
  if (q3 === 'NAO' && state.answers.q7 !== 'SIM') {
    clearCreditQuizState(whatsappDigits);
    return true;
  }

  // Antes do resultado final, confirmar capitais próprios quando for necessário (10% ou 20%)
  if (q3 === 'SIM') {
    const requiredPct = computeRequiredCapitalPercent(q2, q3, q4, state.answers.q5);
    if (requiredPct && state.answers.capitalOk !== 'SIM') {
      state.pendingCapitalPercent = requiredPct;
      state.step = 'AWAIT_CAPITALS';
      setCreditQuizState(whatsappDigits, state);
      await sendEvolutionText(
        whatsappDigits,
        financingCapitalQuestion(/** @type {'casado'|'solteiro'} */ (state.mode), requiredPct),
      );
      return true;
    }
  }

  const outcome = classifyFinancingAnswers(q2, q3, q4, state.answers.q5, state.answers.q7);
  await finishFinancingQuizWithOutcome(whatsappDigits, state, outcome);
  return true;
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

/**
 * Atualiza o comentário de um lead existente (por WhatsApp).
 * @param {string} whatsappDigits
 * @param {string} comentario
 */
async function patchIaAppLeadComment(whatsappDigits, comentario) {
  const base = (process.env.IA_APP_BASE_URL || 'https://ia.rafaapelomundo.com/').replace(/\/$/, '');
  const secret = process.env.IA_APP_INTEGRATION_SECRET || '';
  if (!secret) {
    throw new Error('Integração não configurada no servidor.');
  }
  const body = {
    whatsapp: whatsappDigits,
    comentario: String(comentario || '').trim(),
  };
  if (!body.comentario) {
    throw new Error('Comentário vazio.');
  }

  const res = await fetch(`${base}/api/integration/leads/comment`, {
    method: 'PATCH',
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
  const ok = res.status === 200 && json.ok === true;
  if (ok) return json;

  const apiMsg =
    (Array.isArray(json?.message) ? json.message.join(' ') : json?.message) ||
    json?.error ||
    (raw && raw.length < 800 ? raw.trim() : '') ||
    `Erro HTTP ${res.status}`;
  throw new Error(String(apiMsg).trim() || `Erro HTTP ${res.status}`);
}

function extractGestoraName(gestora) {
  if (!gestora || typeof gestora !== 'object') return null;
  const candidates = [
    gestora.nome,
    gestora.name,
    gestora.displayName,
    gestora.fullName,
    gestora.firstName,
  ];
  for (const c of candidates) {
    const v = String(c || '').trim();
    if (v) return v;
  }
  return null;
}

function extractGestoraWhatsapp(gestora) {
  if (!gestora || typeof gestora !== 'object') return '';
  const candidates = [
    gestora.whatsapp,
    gestora.whatsapp_number,
    gestora.whatsappNumber,
    gestora.phone,
    gestora.phoneNumber,
    gestora.telefone,
    gestora.telephone,
    gestora.mobile,
    gestora.celular,
  ];
  for (const c of candidates) {
    const digits = String(c || '').replace(/\D/g, '').trim();
    if (digits) return digits;
  }
  return '';
}

function buildGestoraWhatsAppLink({ gestoraWhatsapp, leadName, quizSummary }) {
  const digits = String(gestoraWhatsapp || '').replace(/\D/g, '').trim();
  if (!digits) return '';
  const nome = String(leadName || '').trim() || 'Cliente WhatsApp';
  const resumo = String(quizSummary || '').trim() || 'não informado';
  const text = `Ola, meu nome é ${nome}, e vim pela Rafa, minhas respostas ao questionario: ${resumo}`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

async function requestIaAppAtendimento(whatsappDigits) {
  const base = (process.env.IA_APP_BASE_URL || 'https://ia.rafaapelomundo.com/').replace(/\/$/, '');
  const secret = process.env.IA_APP_INTEGRATION_SECRET || '';
  if (!secret) {
    throw new Error('Integração não configurada no servidor.');
  }

  const res = await fetch(`${base}/api/integration/leads/request-atendimento`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Integration-Secret': secret,
    },
    body: JSON.stringify({ whatsapp: whatsappDigits }),
  });
  const raw = await res.text();
  let json = {};
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    json = {};
  }
  const ok = res.status === 200 && json.ok === true;
  if (ok) return json;

  const apiMsg =
    (Array.isArray(json?.message) ? json.message.join(' ') : json?.message) ||
    json?.error ||
    (raw && raw.length < 800 ? raw.trim() : '') ||
    `Erro HTTP ${res.status}`;
  const err = new Error(String(apiMsg).trim() || `Erro HTTP ${res.status}`);
  // @ts-ignore
  err.status = res.status;
  throw err;
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
    await sendEvolutionText(whatsappDigits, 'Erro ao criar a sua conta');
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
  const hello = safeName ? `Oi, ${safeName}, tudo bem?` : 'Oi, tudo bem?';

  const messages = [
    hello,
    'Você tem dúvidas ou já quer mesmo iniciar a sua análise gratuita com a gestora?',
    'Vou falar-lhe basicamente de que forma funciona o processo de crédito habitação.',
    'Você entra em contacto com a gestora ou o gestor: ele recolhe os documentos necessários e leva-os a todos os bancos, não só ao banco onde já tem conta. Ele vê que bancos aprovam o financiamento nas condições de que precisa e quais oferecem melhores taxas. Uma vez aprovado, o banco diz o montante máximo que libera para si… 100 mil, 150 mil, 200 mil, etc. Sabendo esse teto, começa a procurar casas dentro desse valor. O serviço da gestora é gratuito: quem paga a comissão são os bancos.',
    'Em geral os bancos pedem 10% de entrada e financiam 90% do valor do imóvel.',
    'Recomendo estes vídeos, em que falamos do nosso processo e em que tirámos dúvidas com a gestora:',
    'https://www.youtube.com/watch?v=nSuXTX0z9Vk',
    'https://www.youtube.com/watch?v=v04RVqeT9aQ',
    'Para iniciar a análise, deixe o seu contacto neste link; receberá o contacto da gestora por e-mail e a lista de documentos:',
    'https://www.ia.rafaapelomundo.com/credito',
    'Para qualquer dúvida, estou à disposição 😃',
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

async function handleSolicitarAtendimento({
  whatsappDigits,
  contactName,
  uploadUrlHint,
  quizSummaryHint,
}) {
  const nome = String(contactName || '').trim() || 'Cliente WhatsApp';
  let uploadUrl = String(uploadUrlHint || '').trim();
  const quizSummary = String(quizSummaryHint || '').trim();

  try {
    if (!uploadUrl) {
      try {
        const leadData = await createIaAppLead(whatsappDigits, nome);
        uploadUrl = String(leadData?.upload_url || '').trim();
      } catch {
        // segue mesmo sem uploadUrl (tentamos link genérico)
      }
    }

    let atendimento;
    try {
      atendimento = await requestIaAppAtendimento(whatsappDigits);
    } catch (err) {
      if (err?.status === 404) {
        const leadData = await createIaAppLead(whatsappDigits, nome);
        uploadUrl = uploadUrl || String(leadData?.upload_url || '').trim();
        atendimento = await requestIaAppAtendimento(whatsappDigits);
      } else {
        throw err;
      }
    }

    const gestoraNome = extractGestoraName(atendimento?.gestora);
    const msgGestora = gestoraNome
      ? `Perfeito! A gestora ${gestoraNome} foi atribuída ao seu atendimento e vai entrar em contacto consigo o mais breve possível.`
      : 'Perfeito! O seu atendimento foi solicitado e uma gestora foi atribuída. Ela vai entrar em contacto consigo o mais breve possível.';
    await sendEvolutionText(whatsappDigits, msgGestora);
    await sleep(1200);
    const gestoraWhatsapp = extractGestoraWhatsapp(atendimento?.gestora);
    const gestoraWaLink = buildGestoraWhatsAppLink({
      gestoraWhatsapp,
      leadName: nome,
      quizSummary,
    });
    if (gestoraWaLink) {
      await sendEvolutionText(
        whatsappDigits,
        'Use esse link para falar com ela diretamente pelo WhatsApp:',
      );
      await sleep(1200);
      await sendEvolutionText(whatsappDigits, gestoraWaLink);
      await sleep(1200);
    }
    await sendEvolutionText(
      whatsappDigits,
      'Se quiser adiantar e já enviar os documentos necessários para avançar com o processo, pode fazer pelo link:',
    );
    await sleep(1200);
    if (uploadUrl) {
      await sendEvolutionText(whatsappDigits, uploadUrl);
    } else {
      const base = (process.env.IA_APP_BASE_URL || 'https://ia.rafaapelomundo.com/').replace(/\/$/, '');
      await sendEvolutionText(whatsappDigits, `${base}/credito`);
    }
    clearAtendimentoPromptState(whatsappDigits);
    return { ok: true };
  } catch (err) {
    const detail = err?.message || String(err);
    console.warn('[wa-verify] atendimento: falhou', { whatsapp: whatsappDigits, detail });
    await sendEvolutionText(
      whatsappDigits,
      'Não consegui solicitar o atendimento agora. Tente novamente em alguns minutos escrevendo ATENDIMENTO.',
    );
    return { ok: false, error: detail };
  }
}

async function handleAtendimentoPromptResponse(whatsappDigits, trimmed, pushName) {
  const state = getAtendimentoPromptState(whatsappDigits);
  if (!state) return false;

  const ans = parseSimNao(trimmed);
  if (!ans) {
    await sendEvolutionText(
      whatsappDigits,
      'Não entendi. Por favor responda apenas com SIM ou NÃO.',
    );
    return true;
  }

  if (ans === 'SIM') {
    await handleSolicitarAtendimento({
      whatsappDigits,
      contactName: String(pushName || '').trim() || state.contactName || 'Cliente WhatsApp',
      uploadUrlHint: state.uploadUrl,
      quizSummaryHint: state.quizSummary,
    });
    return true;
  }

  clearAtendimentoPromptState(whatsappDigits);
  await sendEvolutionText(
    whatsappDigits,
    'Perfeito! Boa sorte no seu processo. Se quiser tentar novamente, basta escrever ATENDIMENTO.',
  );
  return true;
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
 * O mesmo `messages.upsert` pode listar a mensagem em `data.key` e em `data.messages`.
 * Com `key.id`: uma chave global. Sem id: cai em JID + texto normalizado.
 * @param {{ remoteJid: string, fromMe?: boolean, text: string, pushName?: string, msgId?: string }[]} parts
 */
function dedupeMessageParts(parts) {
  /** @type {Map<string, { remoteJid: string, fromMe?: boolean, text: string, pushName?: string, msgId?: string }>} */
  const byKey = new Map();
  for (const p of parts) {
    let dedupeKey;
    if (p.msgId && String(p.msgId).trim() !== '') {
      dedupeKey = `id:${String(p.msgId).trim()}`;
    } else {
      const textNorm = normalizeText(p.text).normalize('NFKC');
      if (!textNorm.length) continue;
      dedupeKey = `${p.remoteJid}|t:${textNorm}`;
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

function webhookInstanceName(body) {
  const candidates = [body?.instance, body?.instanceName, body?.data?.instance, body?.data?.instanceName];
  for (const c of candidates) {
    const v = String(c || '').trim();
    if (v) return v;
  }
  return '';
}

function resolveSendInstance({ preferredInstance, whatsappDigits }) {
  const preferred = String(preferredInstance || '').trim();
  if (preferred && CHATBOT_ALLOWED_INSTANCES.has(preferred)) return preferred;
  const fromHistory = String(lastInboundInstanceByWhatsapp.get(String(whatsappDigits || '')) || '').trim();
  if (fromHistory && CHATBOT_ALLOWED_INSTANCES.has(fromHistory)) return fromHistory;
  const fallback = String(EVOLUTION_INSTANCE || 'comunidade').trim();
  return fallback || 'comunidade';
}

function resolveSendInstancesOrdered({ preferredInstance, whatsappDigits }) {
  const preferred = resolveSendInstance({ preferredInstance, whatsappDigits });
  const pool = CHATBOT_ALLOWED_INSTANCES.size
    ? Array.from(CHATBOT_ALLOWED_INSTANCES.values())
    : [String(EVOLUTION_INSTANCE || 'comunidade').trim() || 'comunidade'];
  const ordered = [preferred, ...pool.filter((v) => v !== preferred)];
  const failoverRaw = String(process.env.EVOLUTION_FAILOVER_ENABLED || '1')
    .trim()
    .toLowerCase();
  const failoverEnabled = !['0', 'false', 'off', 'no'].includes(failoverRaw);
  return failoverEnabled ? ordered : ordered.slice(0, 1);
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

async function confirmOnCommunity({ code, whatsapp, evolutionInstance }) {
  const bases = [COMMUNITY_API_URL, COMMUNITY_API_URL_FALLBACK].filter(Boolean);
  if (!bases.length) throw new Error('COMMUNITY_API_URL não configurada');

  /** @param {string} base */
  const attempt = async (base) => {
    const res = await fetch(`${base}/auth/whatsapp/confirm`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(COMMUNITY_INTERNAL_SECRET ? { 'x-internal-secret': COMMUNITY_INTERNAL_SECRET } : {}),
      },
      body: JSON.stringify({
        code,
        whatsapp,
        evolutionInstance: evolutionInstance || undefined,
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        (Array.isArray(json?.message) ? json.message.join(' ') : json?.message) ||
        json?.error ||
        `Erro ${res.status}`;
      const err = new Error(String(msg));
      // @ts-ignore - attach metadata for fallback logic
      err.status = res.status;
      // @ts-ignore
      err.base = base;
      throw err;
    }
    return json;
  };

  /** @type {any[]} */
  const errors = [];
  for (let i = 0; i < bases.length; i++) {
    const base = bases[i];
    try {
      const out = await attempt(base);
      if (i > 0) {
        console.warn('[wa-verify] confirm: fallback usado', { base });
      }
      return out;
    } catch (err) {
      errors.push(err);
      const status = err?.status;
      // Só tenta o próximo ambiente quando parecer "código não encontrado/expirado".
      const shouldFallback =
        i < bases.length - 1 &&
        (status === 400 || status === 404 || /c[oó]digo/i.test(String(err?.message || '')));
      if (!shouldFallback) throw err;
    }
  }
  throw errors[errors.length - 1] || new Error('Falha ao confirmar no backend');
}

async function sendEvolutionText(toDigits, text, preferredInstance) {
  const base = EVOLUTION_API_URL.replace(/\/$/, '');
  const key = EVOLUTION_API_KEY;
  const instances = resolveSendInstancesOrdered({
    preferredInstance,
    whatsappDigits: toDigits,
  });
  if (!base || !key) {
    console.warn(
      '[wa-verify] EVOLUTION_API_URL ou EVOLUTION_API_KEY ausentes; resposta automática não enviada.',
    );
    return;
  }
  const number = String(toDigits || '').replace(/\D/g, '');
  if (!number) return;
  let lastError = '';
  for (const instance of instances) {
    try {
      const res = await fetch(`${base}/message/sendText/${instance}`, {
        method: 'POST',
        headers: { apikey: key, 'content-type': 'application/json' },
        body: JSON.stringify({ number, text }),
      });
      if (res.ok) return;
      const body = await res.text().catch(() => '');
      lastError = `${res.status} ${body}`.trim();
    } catch (err) {
      lastError = err?.message ? String(err.message) : 'erro de rede';
    }
  }
  console.warn('[wa-verify] Evolution sendText falhou em todas as instâncias:', lastError);
}

async function sendEvolutionImageFromPath(toDigits, imagePath, caption = '', preferredInstance) {
  const base = EVOLUTION_API_URL.replace(/\/$/, '');
  const key = EVOLUTION_API_KEY;
  const instances = resolveSendInstancesOrdered({
    preferredInstance,
    whatsappDigits: toDigits,
  });
  if (!base || !key) {
    console.warn(
      '[wa-verify] EVOLUTION_API_URL ou EVOLUTION_API_KEY ausentes; mídia não enviada.',
    );
    return;
  }
  const number = String(toDigits || '').replace(/\D/g, '');
  if (!number) return;

  const buf = await fs.readFile(imagePath);
  const base64 = buf.toString('base64');
  const fileName = path.basename(imagePath) || 'imagem.png';
  let lastError = '';
  for (const instance of instances) {
    try {
      const res = await fetch(`${base}/message/sendMedia/${instance}`, {
        method: 'POST',
        headers: { apikey: key, 'content-type': 'application/json' },
        body: JSON.stringify({
          number,
          mediatype: 'Image',
          mimetype: 'image/png',
          caption: caption || '',
          media: base64,
          fileName,
        }),
      });
      if (res.ok) return;
      const body = await res.text().catch(() => '');
      lastError = `${res.status} ${body}`.trim();
    } catch (err) {
      lastError = err?.message ? String(err.message) : 'erro de rede';
    }
  }
  console.warn('[wa-verify] Evolution sendMedia falhou em todas as instâncias:', lastError);
}

async function resolveCasaImagePath() {
  const envPath = String(process.env.CASA_IMAGE_PATH || '').trim();
  const candidates = [
    envPath,
    path.resolve(process.cwd(), '../frontend/public/casa.png'),
    path.resolve(process.cwd(), '../../frontend/public/casa.png'),
    path.resolve(__dirname, '../../frontend/public/casa.png'),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      await fs.access(p);
      return p;
    } catch {
      // tenta próximo candidato
    }
  }
  return '';
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
  const evolutionInstance = resolveSendInstance({ whatsappDigits });
  confirmOnCommunity({ code, whatsapp: whatsappDigits, evolutionInstance })
    .then(() => console.log('[wa-verify] conta confirmada no backend', { whatsapp: whatsappDigits }))
    .catch((err) => console.error('[wa-verify] confirm failed:', err?.message || err));
}

function bufferIncomingMessage(whatsappDigits, text, instanceName) {
  const trimmed = text && String(text).trim();
  if (!trimmed) return false;

  const inst = String(instanceName || '').trim();
  if (inst) {
    lastInboundInstanceByWhatsapp.set(whatsappDigits, inst);
  }

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

    const instanceName = webhookInstanceName(req.body);
    if (instanceName && CHATBOT_ALLOWED_INSTANCES.size > 0 && !CHATBOT_ALLOWED_INSTANCES.has(instanceName)) {
      return res.json({ ok: true, ignored: true, reason: 'instance-not-allowed', instance: instanceName });
    }

    const parts = listIncomingMessageParts(req.body);
    let anyBuffered = false;
    for (const { remoteJid, text, pushName, msgId } of parts) {
      const whatsapp = normalizeWhatsappFromJid(remoteJid);
      if (!whatsapp) continue;
      if (instanceName) {
        lastInboundInstanceByWhatsapp.set(whatsapp, instanceName);
      }
      const trimmed = text && String(text).trim();
      if (!trimmed) continue;

      if (!claimInboundMessageOnce(msgId)) {
        anyBuffered = true;
        continue;
      }

      // Gatilhos globais (reiniciam / cancelam quiz de financiamento em curso)
      const normalized = normalizeText(maybeUrlDecodeInboundText(trimmed));
      if (FINANCING_QUIZ_TRIGGERS.has(normalized) || /^questionario\b/.test(normalized)) {
        clearCreditQuizState(whatsapp);
        clearAtendimentoPromptState(whatsapp);
        startFinancingQuiz(whatsapp, pushName || '').catch((err) => {
          console.warn('[wa-verify] financing-quiz: erro ao iniciar', err?.message || err);
        });
        anyBuffered = true;
        continue;
      }

      if (normalizeText(trimmed) === CREDIT_HELP_TRIGGER) {
        clearCreditQuizState(whatsapp);
        clearAtendimentoPromptState(whatsapp);
        sendCreditHelpFlow({ whatsappDigits: whatsapp, contactName: pushName }).catch((err) => {
          console.warn('[wa-verify] credit-help: erro ao enviar flow:', err?.message || err);
        });
        anyBuffered = true;
        continue;
      }

      if (normalizeText(trimmed) === CREATE_ACCOUNT_TRIGGER) {
        clearCreditQuizState(whatsapp);
        clearAtendimentoPromptState(whatsapp);
        sendCreateAccountFlow({ whatsappDigits: whatsapp, contactName: pushName }).catch((err) => {
          console.warn('[wa-verify] create-account: exceção:', err?.message || err);
        });
        anyBuffered = true;
        continue;
      }

      if (normalized === WANT_HOUSE_TRIGGER || /^quero casa\b/.test(normalized)) {
        try {
          const imagePath = await resolveCasaImagePath();
          if (!imagePath) {
            await sendEvolutionText(
              whatsapp,
              'Não consegui localizar a imagem de teste (casa.png).',
            );
          } else {
            await sendEvolutionImageFromPath(
              whatsapp,
              imagePath,
              '🏠 Aqui está a imagem de teste da casa.',
              instanceName,
            );
          }
        } catch (err) {
          console.warn('[wa-verify] want-house: falha ao enviar imagem', err?.message || err);
          await sendEvolutionText(
            whatsapp,
            'Não consegui enviar a imagem agora. Tente novamente em alguns instantes.',
            instanceName,
          );
        }
        anyBuffered = true;
        continue;
      }

      if (normalized === ATENDIMENTO_TRIGGER || /^atendimento\b/.test(normalized)) {
        clearCreditQuizState(whatsapp);
        await handleSolicitarAtendimento({
          whatsappDigits: whatsapp,
          contactName: pushName || '',
          uploadUrlHint: getAtendimentoPromptState(whatsapp)?.uploadUrl || '',
          quizSummaryHint: getAtendimentoPromptState(whatsapp)?.quizSummary || '',
        });
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

      if (getAtendimentoPromptState(whatsapp)) {
        const consumedAtendimento = await handleAtendimentoPromptResponse(
          whatsapp,
          trimmed,
          pushName || '',
        );
        if (consumedAtendimento) {
          anyBuffered = true;
          continue;
        }
      }

      if (bufferIncomingMessage(whatsapp, trimmed, instanceName)) anyBuffered = true;
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
