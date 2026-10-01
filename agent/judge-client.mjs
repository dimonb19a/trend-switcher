// Zero-dependency client for the judge: a typed-question model behind an HTTP API, not a chat LLM.
// You bring your own provider (JUDGE_BASE_URL, JUDGE_MODEL, JUDGE_API_KEY); the agent never names
// one. The request/answer contract this client speaks:
//   POST {baseUrl}/v1/systemone   Authorization: Bearer <key>
//   body    { state, model, questions: { <id>: Question } }      Question: noul | choice | score
//   answer  { model, answers: { <id>: Answer }, usage: { input_tokens, output_tokens } }
//   errors  401 (key), 422 (validation), 429 (rate limit), 529 (overloaded)
// Every answer is a probability (noul) or a probability distribution over fixed choices or score
// levels; the agent consumes those numbers, never prose.
//
// The key comes from the environment only (JUDGE_API_KEY) and is never logged. It travels only to
// the configured provider origin (JUDGE_BASE_URL, optionally extended by JUDGE_KEY_ORIGINS): a
// loopback literal stand-in (127.0.0.1 / [::1]) gets no key at all, and any other endpoint is
// refused before the key is even resolved. Pricing is NOT built into this file: set
// JUDGE_PRICE_USD_PER_MTOK_INPUT and JUDGE_PRICE_USD_PER_MTOK_OUTPUT from your provider's current
// price list so the ledger can price each call from its usage; without both, the cost of a call is
// unknown (null) and the agent records it as an UNKNOWN bill, never as a zero. A price variable that
// is present but blank or malformed is a configuration error, not a zero price; an explicit `0` is a
// zero price. A reply whose answers fail validation still carries its usage on the thrown error, so a
// paid-but-unusable answer keeps its known bill. The model id is pinned on purpose (JUDGE_MODEL): an
// alias that moves when a provider ships a new release would silently change the judge under
// thresholds calibrated against one version; a reply from any other model is discarded, its bill kept.
import { RecordableError } from './errors.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';

export const BASE_URL_ENV = 'JUDGE_BASE_URL';
export const MODEL_ENV = 'JUDGE_MODEL';
export const KEY_ENVS = Object.freeze(['JUDGE_API_KEY']);
export const KEY_ORIGINS_ENV = 'JUDGE_KEY_ORIGINS';
export const PRICE_ENVS = Object.freeze(['JUDGE_PRICE_USD_PER_MTOK_INPUT', 'JUDGE_PRICE_USD_PER_MTOK_OUTPUT']);

// Documented request limits.
export const LIMITS = Object.freeze({
  totalTokens: 64_000, // all state + all questions
  stateAndLongestQuestionTokens: 32_000,
  choiceOptionsMax: 255,
  scoreLevelsMin: 2,
  scoreLevelsMax: 10,
});

const QUESTION_TYPES = new Set(['noul', 'choice', 'score']);

/** Rough token estimate: four characters per token, over the JSON form. */
export function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return Math.ceil(text.length / 4);
}

/** The key a call would use, from the environment only. '' when unset. Never logged. */
export function resolveApiKey(env = process.env) {
  for (const name of KEY_ENVS) {
    const value = env[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

/** 'set' or 'unset'. Never returns or prints the value. */
export function keyStatus(env = process.env) {
  return resolveApiKey(env) !== '' ? 'set' : 'unset';
}

/**
 * One parser for a price variable, shared by the configuration and the client: absent (undefined or
 * null) → unknown; present but blank, not a number or negative → invalid (a configuration error);
 * a finite non-negative number, `0` included → set.
 */
export function parsePrice(raw) {
  if (raw === undefined || raw === null) return { state: 'absent', value: null };
  const text = String(raw).trim();
  if (text === '') return { state: 'blank', value: null };
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return { state: 'invalid', value: null };
  return { state: 'set', value };
}

/** Configuration problems of the price variables: a present-but-unusable value is named, an absent one is not a problem (it means UNKNOWN bills). */
export function priceProblems(env = process.env) {
  const problems = [];
  for (const name of PRICE_ENVS) {
    const { state } = parsePrice(env[name]);
    if (state === 'blank') problems.push(`${name} is set but blank: unset it (UNKNOWN bills) or give a non-negative number (0 for a free endpoint)`);
    else if (state === 'invalid') problems.push(`${name} is not a non-negative number`);
  }
  return problems;
}

/** True when both price variables are set to finite non-negative numbers (blank or malformed never counts). */
export function priceConfigured(env = process.env) {
  return PRICE_ENVS.every((name) => parsePrice(env[name]).state === 'set');
}

/** Usage the ledger can bill: both token counts present as non-negative integers. */
export function validUsage(usage) {
  return Boolean(usage) && typeof usage === 'object' && ['input_tokens', 'output_tokens'].every((k) => Number.isSafeInteger(usage[k]) && usage[k] >= 0);
}

/** The USD cost of one call from its usage and the configured prices, or null when either is unknown. */
export function priceUsd(usage, env = process.env) {
  if (!priceConfigured(env) || !validUsage(usage)) return null;
  const [input, output] = PRICE_ENVS.map((name) => parsePrice(env[name]).value);
  return (usage.input_tokens / 1e6) * input + (usage.output_tokens / 1e6) * output;
}

/** The validated base URL from the environment: an HTTPS origin, or a plain HTTP loopback-literal origin for a local stand-in. */
export function endpointBaseUrl(env = process.env) {
  const raw = env[BASE_URL_ENV];
  if (typeof raw !== 'string' || raw.trim() === '') throw new JudgeError(`no judge endpoint: set ${BASE_URL_ENV} to your provider's API origin`);
  return assertEndpointAllowed(raw.trim());
}

/** A loopback LITERAL only: `localhost` is a name that DNS may resolve anywhere, so it is not one. */
function isLoopbackLiteral(url) {
  return (url.protocol === 'http:' || url.protocol === 'https:') && (url.hostname === '127.0.0.1' || url.hostname === '[::1]');
}

/** No URL credentials, path prefix, query or fragment; HTTPS unless a loopback literal. Never echoes the rejected URL. */
export function assertEndpointAllowed(baseUrl) {
  let url;
  if (baseUrl === null || baseUrl === undefined || baseUrl === '') throw new JudgeError(`no judge endpoint: set ${BASE_URL_ENV} to your provider's API origin`);
  try { url = new URL(baseUrl); } catch { throw new JudgeError('invalid judge endpoint'); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || /^[a-z][a-z\d+.-]*:\/\/[^/?#]*@/iu.test(baseUrl)
    || (url.protocol !== 'https:' && !isLoopbackLiteral(url))) {
    throw new JudgeError('the judge endpoint must be an HTTPS origin (or a plain loopback-literal origin) without credentials, path, query or fragment');
  }
  return url.origin;
}

/**
 * The origins allowed to receive the judge key: the configured provider origin (JUDGE_BASE_URL)
 * plus any listed in JUDGE_KEY_ORIGINS (comma-separated). Nothing is allowed by default.
 */
export function keyOrigins(env = process.env) {
  const entries = [];
  const base = env[BASE_URL_ENV];
  if (typeof base === 'string' && base.trim() !== '') entries.push(base.trim());
  const raw = env[KEY_ORIGINS_ENV];
  if (typeof raw === 'string' && raw.trim() !== '') entries.push(...raw.split(',').map((s) => s.trim()).filter(Boolean));
  const origins = entries.map((entry) => {
    try { return assertEndpointAllowed(entry); } catch { throw new JudgeError(`${BASE_URL_ENV} / ${KEY_ORIGINS_ENV} must be HTTPS origins without credentials, path, query or fragment`); }
  });
  return [...new Set(origins)];
}

/**
 * Where a call may go and whether the provider key travels with it, decided BEFORE the key is
 * resolved: the configured provider origin (or one listed in JUDGE_KEY_ORIGINS) gets the key; a
 * loopback literal gets none (a local stand-in never sees the credential); any other endpoint is
 * refused.
 */
export function credentialPolicy(baseUrl, env = process.env) {
  const origin = assertEndpointAllowed(baseUrl);
  if (isLoopbackLiteral(new URL(origin))) return { origin, sendKey: false };
  if (keyOrigins(env).includes(origin)) return { origin, sendKey: true };
  throw new JudgeError(`the judge endpoint origin is not allowed to receive the judge key; it must be ${BASE_URL_ENV} itself or listed in ${KEY_ORIGINS_ENV}`);
}

function isEntry(value) {
  return value === null || typeof value === 'string' || (typeof value === 'object');
}

/** Local validation of the questions map, mirroring the documented shapes, so a malformed request fails before it costs a round trip. */
export function questionProblems(questions) {
  const problems = [];
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) {
    return ['questions must be a non-empty object keyed by question id'];
  }
  const ids = Object.keys(questions);
  if (ids.length === 0) problems.push('questions must contain at least one question');
  for (const id of ids) {
    const q = questions[id];
    const where = `question "${id}"`;
    if (!q || typeof q !== 'object') { problems.push(`${where}: not an object`); continue; }
    if (!QUESTION_TYPES.has(q.type)) problems.push(`${where}: type must be noul, choice or score`);
    if (q.instructions === undefined || !isEntry(q.instructions)) problems.push(`${where}: instructions required (string, object or array)`);
    if (q.type === 'choice') {
      const c = q.criteria;
      if (!c || typeof c !== 'object' || Array.isArray(c)) problems.push(`${where}: choice criteria must be a map of option → description|null`);
      else {
        const n = Object.keys(c).length;
        if (n < 2) problems.push(`${where}: choice needs at least two options`);
        if (n > LIMITS.choiceOptionsMax) problems.push(`${where}: choice allows at most ${LIMITS.choiceOptionsMax} options, got ${n}`);
      }
    } else if (q.type === 'score') {
      const c = q.criteria;
      if (!Array.isArray(c)) problems.push(`${where}: score criteria must be an ordered array of level descriptions`);
      else if (c.length < LIMITS.scoreLevelsMin || c.length > LIMITS.scoreLevelsMax) problems.push(`${where}: score needs ${LIMITS.scoreLevelsMin}–${LIMITS.scoreLevelsMax} levels, got ${c.length}`);
    } else if (q.type === 'noul' && q.criteria !== undefined) {
      const c = q.criteria;
      if (!c || typeof c !== 'object' || Array.isArray(c)) problems.push(`${where}: noul criteria, when present, must be { true?, false? }`);
    }
  }
  return problems;
}

/** Budget problems for one request, against the documented context limits. */
export function budgetProblems(state, questions) {
  const problems = [];
  const stateTokens = estimateTokens(state);
  let longest = 0; let total = stateTokens;
  for (const q of Object.values(questions ?? {})) { const t = estimateTokens(q); total += t; if (t > longest) longest = t; }
  if (total > LIMITS.totalTokens) problems.push(`estimated ${total} tokens exceeds the ${LIMITS.totalTokens}-token request budget`);
  if (stateTokens + longest > LIMITS.stateAndLongestQuestionTokens) problems.push(`estimated state (${stateTokens}) + longest question (${longest}) exceeds ${LIMITS.stateAndLongestQuestionTokens} tokens`);
  return { problems, stateTokens, totalTokens: total, longestQuestionTokens: longest };
}

export class JudgeError extends RecordableError {
  constructor(message, { status = null, attempts = 0, usage = null, model = null } = {}) {
    super(message);
    this.name = 'JudgeError';
    this.status = status;
    this.attempts = attempts;
    // Billing facts of a reply that was received but could not be used: the caller books them.
    this.usage = usage;
    this.model = model;
  }
}

function parseResponse(text, status) {
  try { return JSON.parse(text); } catch {
    // JSON.parse errors can quote the response body; do not expose those bytes.
    throw new JudgeError('invalid JSON from the judge endpoint', { status });
  }
}

/** Validates every answer against its question; throws a JudgeError that carries the reply's usage and model when the shape is wrong. */
function checkAnswers(response, questions) {
  const map = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const sameKeys = (value, keys) => map(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
  const probability = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
  const halfUnit = 0.00005; const epsilon = 1e-10;
  const billing = { usage: map(response?.usage) ? response.usage : null, model: typeof response?.model === 'string' ? response.model : null };
  const invalid = () => { throw new JudgeError('response contains a missing or invalid answer', billing); };
  const answers = response?.answers;
  if (!response || typeof response.model !== 'string' || response.model.trim().length === 0 || !sameKeys(answers, Object.keys(questions))) {
    throw new JudgeError('response without a model and answers map', billing);
  }
  for (const [id, question] of Object.entries(questions)) {
    const answer = answers[id];
    if (!map(answer) || answer.type !== question.type) invalid();
    if (question.type === 'noul') {
      if (!probability(answer.noul) || (answer.confidence !== undefined && !probability(answer.confidence))) invalid();
      continue;
    }
    const keys = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
    if (!probability(answer.confidence) || !sameKeys(answer.probabilities, keys)) invalid();
    const values = keys.map((key) => answer.probabilities[key]);
    if (!values.every(probability) || Math.abs(values.reduce((sum, p) => sum + p, 0) - 1) > keys.length * halfUnit + epsilon) invalid();
    if (question.type === 'choice') {
      if (typeof answer.choice !== 'string' || !Object.hasOwn(answer.probabilities, answer.choice) || Math.max(...values) - answer.probabilities[answer.choice] > 2 * halfUnit + epsilon) invalid();
    } else {
      if (!Number.isFinite(answer.score) || answer.score < 0 || answer.score > keys.length - 1 || !sameKeys(answer.legend, keys)
        || !keys.every((key, index) => isDeepStrictEqual(answer.legend[key], question.criteria[index]))) invalid();
      const expected = values.reduce((sum, p, index) => sum + index * p, 0);
      const tolerance = halfUnit * (1 + keys.length * (keys.length - 1) / 2) + epsilon;
      if (Math.abs(answer.score - expected) > tolerance) invalid();
    }
  }
}

function retryAfterMs(response) {
  const header = response.headers?.get?.('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/**
 * One judge call. The endpoint is checked against the credential policy before anything else: the
 * provider key is attached only for an allowed origin, a loopback literal gets no key, anything else
 * is refused before the key is resolved. The model id must be given (the pin). Redirects are
 * refused. 429/529 are retried with exponential backoff honouring `retry-after` (up to maxAttempts);
 * 401/422 never. A transport failure is retried up to maxAttempts. Resolves with the parsed,
 * validated response { model, answers, usage }.
 */
export async function askJudge(
  { state, questions, model },
  { baseUrl, apiKey, env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 30_000, maxAttempts = 4, backoffMs = 500, sleep = delay } = {},
) {
  if (typeof model !== 'string' || model.trim() === '') throw new JudgeError(`no judge model pin: set ${MODEL_ENV} to the exact model id your provider documents`);
  const policy = credentialPolicy(baseUrl ?? (typeof env[BASE_URL_ENV] === 'string' && env[BASE_URL_ENV].trim() !== '' ? env[BASE_URL_ENV].trim() : null), env);
  baseUrl = policy.origin;
  const headers = { 'Content-Type': 'application/json' };
  if (policy.sendKey) {
    apiKey = apiKey === undefined ? resolveApiKey(env) : apiKey;
    if (typeof apiKey !== 'string' || apiKey.trim() === '') throw new JudgeError(`no judge API key: set ${KEY_ENVS.join(' or ')}`);
    headers.Authorization = `Bearer ${apiKey}`;
  } else {
    apiKey = '';
  }
  const shapeProblems = questionProblems(questions);
  if (shapeProblems.length) throw new JudgeError(`malformed questions: ${shapeProblems.join('; ')}`, { status: 422 });
  const budget = budgetProblems(state, questions);
  if (budget.problems.length) throw new JudgeError(`over budget: ${budget.problems.join('; ')}`, { status: 422 });

  const url = `${baseUrl.replace(/\/+$/u, '')}/v1/systemone`;
  const body = JSON.stringify({ state, model, questions });
  if (apiKey.length >= 16 && body.includes(apiKey)) throw new JudgeError('the state or the questions contain the API key; nothing was sent', { status: 422 });
  let attempt = 0; let wait = backoffMs;
  for (;;) {
    attempt += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response; let text;
    try {
      response = await fetchImpl(url, { method: 'POST', headers, body, signal: controller.signal, redirect: 'manual' });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {});
        throw new JudgeError('redirect refused by the judge client', { status: response.status, attempts: attempt });
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status !== 429 && response.status !== 529) throw new JudgeError(`HTTP ${response.status} from the judge endpoint`, { status: response.status, attempts: attempt });
      } else {
        text = await response.text();
      }
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof JudgeError) throw error;
      if (attempt >= maxAttempts) throw new JudgeError(`transport failure after ${attempt} attempt${attempt === 1 ? '' : 's'}: ${error?.name ?? 'error'}`, { attempts: attempt });
      await sleep(wait); wait *= 2; continue;
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 429 || response.status === 529) {
      if (attempt >= maxAttempts) throw new JudgeError(`HTTP ${response.status} after ${attempt} attempts`, { status: response.status, attempts: attempt });
      await sleep(retryAfterMs(response) ?? wait); wait *= 2; continue;
    }
    const parsed = parseResponse(text, response.status);
    checkAnswers(parsed, questions);
    return parsed;
  }
}
