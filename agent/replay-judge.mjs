// The judge of a replay: the same questions, the same client, the same model pin — with two
// differences stated here. The state both models read hides the calendar date (a model that has
// seen the period in training should not be handed the day; the price level remains, so a replay
// is a screening with that caveat, never a proof), and a rate-limited reply (429/529) is retried a
// few times instead of counting as a lost judgment, because a replay's throughput, not the market,
// is what hits the vendor's limit.
import { cfg } from './config.mjs';
import * as client from './judge-client.mjs';
import { QUESTIONS, summarize } from './judge.mjs';
import { renderState } from './features.mjs';

export const HIDDEN_TIME_LINE = 'Time (UTC): not provided.';

/** The live state text with its date line replaced; everything else byte-identical. */
export function renderStateHiddenDate(features, position, market) {
  return renderState(features, position, market).replace(/^Time \(UTC\): .*$/mu, HIDDEN_TIME_LINE);
}

export function createReplayJudge({ maxAttempts = 4, timeoutMs = 20_000 } = {}) {
  async function judge(stateText) {
    const requestAt = new Date().toISOString();
    const startedAt = Date.now();
    let response;
    try {
      response = await client.askJudge({ state: stateText, questions: QUESTIONS, model: cfg.judgeModel }, { baseUrl: cfg.judgeBaseUrl, timeoutMs, maxAttempts });
    } catch (error) {
      if (error?.usage !== undefined && error.costUsd === undefined) error.costUsd = client.validUsage(error.usage) ? client.priceUsd(error.usage) : null;
      throw error;
    }
    const usage = response.usage;
    const costUsd = client.validUsage(usage) ? client.priceUsd(usage) : null;
    if (response.model !== cfg.judgeModel) {
      const error = new client.JudgeError('judge model does not match the pin', { usage, model: response.model });
      Object.assign(error, { costUsd }); throw error;
    }
    return { model: response.model, answers: response.answers, usage: response.usage ?? null, costUsd, ms: Date.now() - startedAt, requestAt, responseAt: new Date().toISOString() };
  }
  return { judge, summarize, keyStatus: () => client.keyStatus(), pinnedModel: () => cfg.judgeModel, priceConfigured: () => client.priceConfigured(), isJudgeError: (error) => error instanceof client.JudgeError };
}
