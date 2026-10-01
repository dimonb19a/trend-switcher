// The fast judge: four typed questions per tick to the judge model (a typed-question model behind
// an HTTP API, provider of your choice) through judge-client.mjs. The key lives in the environment
// only and is never touched here; the model returned must be the pinned one (JUDGE_MODEL). A reply that was received but cannot be
// used (malformed answers, a wrong model) still carries its usage and price on the thrown error,
// so the engine books a known bill and discards the answer instead of guessing.
import { cfg } from './config.mjs';
import * as client from './judge-client.mjs';

export const QUESTIONS = Object.freeze({
  regime: {
    type: 'choice',
    instructions: 'Using only the numbers in the state, which regime best describes ETH over the last hours? If the data quality line says DEGRADED or key numbers are unavailable, answer chaotic.',
    criteria: {
      trend_up: 'prices are rising with the trend measures agreeing (EMA20 above EMA50, positive slope, positive multi-hour returns)',
      trend_down: 'prices are falling with the trend measures agreeing (EMA20 below EMA50, negative slope, negative multi-hour returns)',
      range: 'no clear direction; returns over different horizons disagree or are small relative to volatility',
      chaotic: 'volatility is unusually high, the numbers are inconsistent, or the data is degraded or unavailable; conditions are not readable',
    },
  },
  direction_15m: {
    type: 'choice',
    instructions: 'Where is the ETH price more likely to be in 15 minutes compared to now, by more than the execution cost stated in the state? This is a forecast; answer flat unless the numbers clearly favour one side.',
    criteria: {
      up: 'higher by more than the switching cost',
      down: 'lower by more than the switching cost',
      flat: 'within the switching cost either way, or unknowable from these numbers',
    },
  },
  switch_quality: {
    type: 'choice',
    instructions: 'Given the current position, the data quality and the execution cost, is this a good moment to switch the whole position between ETH and USDC?',
    criteria: {
      good: 'the evidence is consistent across horizons, the data is not degraded, and the expected move clearly exceeds the cost',
      marginal: 'some evidence, but the move barely covers the cost or the horizons disagree',
      bad: 'no reason to switch now; costs would likely exceed the benefit, or the data is degraded',
    },
  },
  risk_off: {
    type: 'noul',
    instructions: 'Do the numbers show an abnormal condition that argues for not trading at all right now (degraded or unavailable data, extreme volatility relative to the day, extreme spread, or inconsistent numbers)?',
  },
});

const validUsage = client.validUsage; // non-negative integer token counts, the same rule the client prices by

/** One judgment. Throws JudgeError on transport or contract problems; the caller treats that as "no judgment" and books any known bill the error carries. */
export async function judge(stateText) {
  const requestAt = new Date().toISOString();
  const startedAt = Date.now();
  let response;
  try {
    response = await client.askJudge({ state: stateText, questions: QUESTIONS, model: cfg.judgeModel }, { baseUrl: cfg.judgeBaseUrl, timeoutMs: 20_000, maxAttempts: 1 });
  } catch (error) {
    if (error?.usage !== undefined && error.costUsd === undefined) error.costUsd = validUsage(error.usage) ? client.priceUsd(error.usage) : null;
    throw error;
  }
  const usage = response.usage;
  const costUsd = validUsage(usage) ? client.priceUsd(usage) : null;
  if (response.model !== cfg.judgeModel) {
    const error = new client.JudgeError('judge model does not match the pin', { usage, model: response.model });
    Object.assign(error, { costUsd }); throw error;
  }
  return { model: response.model, answers: response.answers, usage: response.usage ?? null, costUsd, ms: Date.now() - startedAt, requestAt, responseAt: new Date().toISOString() };
}

/** Flatten the answers map into the numbers the policy uses. */
export function summarize(answers) {
  const regime = answers.regime; const direction = answers.direction_15m; const quality = answers.switch_quality; const risk = answers.risk_off;
  return {
    regime: regime.choice, regimeP: regime.probabilities[regime.choice],
    direction: direction.choice, directionP: direction.probabilities[direction.choice],
    upP: direction.probabilities.up, downP: direction.probabilities.down,
    quality: quality.choice, qualityP: quality.probabilities[quality.choice],
    riskOffP: risk.noul,
  };
}

export const keyStatus = () => client.keyStatus();
export const pinnedModel = () => cfg.judgeModel;
export const priceConfigured = () => client.priceConfigured();
export const isJudgeError = (error) => error instanceof client.JudgeError;
