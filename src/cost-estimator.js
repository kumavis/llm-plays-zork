// Estimates the standard-tier OpenAI API-equivalent cost of recorded usage.
//
// These estimates are not the amount charged for Codex runs authenticated
// through a ChatGPT subscription. Prices are the public per-million-token
// rates published on 2026-09-02:
// https://developers.openai.com/api/docs/models/compare
//
// Usage follows the Responses API shape: inputTokens includes cached reads
// and cache writes, while thinkingTokens is a subset of outputTokens and is
// therefore not billed a second time. Historical eval logs aggregate usage
// across requests. When repair removes unsuccessful model turns, their token
// usage cannot be identified exactly, so each affected attempt is prorated by
// its retained/recorded turn ratio. The logs also cannot reveal which requests,
// if any, crossed the 272K-token threshold for long-context surcharges, so the
// estimate deliberately excludes that unknowable surcharge.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const TOKENS_PER_MILLION = 1_000_000;

export const OPENAI_PRICING_AS_OF = '2026-09-02';
export const OPENAI_PRICING_SOURCE =
  'https://developers.openai.com/api/docs/models/compare';
export const OPENAI_COST_FORMULA =
  '(uncachedInput * inputPrice + cachedInput * cachedInputPrice + ' +
  'cacheWrite * 1.25 * inputPrice + output * outputPrice) / 1_000_000';

// USD per million tokens. Cache writes cost 1.25x ordinary input.
export const OPENAI_TOKEN_PRICES = Object.freeze({
  'gpt-5.6-sol': Object.freeze({
    input: 4,
    cachedInput: 0.4,
    output: 20,
  }),
  'gpt-5.6-terra': Object.freeze({
    input: 2,
    cachedInput: 0.2,
    output: 12,
  }),
  'gpt-5.6-luna': Object.freeze({
    input: 0.2,
    cachedInput: 0.02,
    output: 1.2,
  }),
});

function priceFor(model) {
  if (model === 'gpt-5.6') {
    return ['gpt-5.6-sol', OPENAI_TOKEN_PRICES['gpt-5.6-sol']];
  }
  return Object.entries(OPENAI_TOKEN_PRICES).find(
    ([id]) => model === id || model.startsWith(`${id}-`),
  );
}

function tokenCount(value, name) {
  const count = value ?? 0;
  if (!Number.isFinite(count) || count < 0) {
    throw new TypeError(`${name} must be a non-negative finite number`);
  }
  return count;
}

export function estimateOpenAiApiCost(model, usage = {}) {
  const priced = priceFor(model);
  if (!priced) return null;
  const [priceModel, prices] = priced;
  const inputTokens = tokenCount(usage.inputTokens, 'inputTokens');
  const cachedInputTokens = tokenCount(
    usage.cacheReadTokens,
    'cacheReadTokens',
  );
  const cacheWriteTokens = tokenCount(
    usage.cacheWriteTokens,
    'cacheWriteTokens',
  );
  const outputTokens = tokenCount(usage.outputTokens, 'outputTokens');
  const reasoningTokens = tokenCount(
    usage.thinkingTokens,
    'thinkingTokens',
  );
  if (cachedInputTokens + cacheWriteTokens > inputTokens) {
    throw new RangeError(
      'cached input plus cache writes cannot exceed total input tokens',
    );
  }
  if (reasoningTokens > outputTokens) {
    throw new RangeError('reasoning tokens cannot exceed output tokens');
  }

  const uncachedInputTokens =
    inputTokens - cachedInputTokens - cacheWriteTokens;
  const cacheWritePrice = prices.input * 1.25;
  const uncachedInputUsd =
    (uncachedInputTokens / TOKENS_PER_MILLION) * prices.input;
  const cachedInputUsd =
    (cachedInputTokens / TOKENS_PER_MILLION) * prices.cachedInput;
  const cacheWriteUsd =
    (cacheWriteTokens / TOKENS_PER_MILLION) * cacheWritePrice;
  const outputUsd =
    (outputTokens / TOKENS_PER_MILLION) * prices.output;

  return {
    kind: 'api-equivalent-estimate',
    model: priceModel,
    pricingAsOf: OPENAI_PRICING_AS_OF,
    pricingSource: OPENAI_PRICING_SOURCE,
    formula: OPENAI_COST_FORMULA,
    currency: 'USD',
    totalUsd: uncachedInputUsd + cachedInputUsd + cacheWriteUsd + outputUsd,
    tokens: {
      input: inputTokens,
      uncachedInput: uncachedInputTokens,
      cachedInput: cachedInputTokens,
      cacheWrite: cacheWriteTokens,
      output: outputTokens,
      reasoning: reasoningTokens,
    },
    usdPerMillionTokens: {
      input: prices.input,
      cachedInput: prices.cachedInput,
      cacheWrite: cacheWritePrice,
      output: prices.output,
    },
    breakdownUsd: {
      uncachedInput: uncachedInputUsd,
      cachedInput: cachedInputUsd,
      cacheWrite: cacheWriteUsd,
      output: outputUsd,
    },
    assumptions: {
      subscriptionSpend: false,
      reasoningIncludedInOutput: true,
      longContextSurchargeIncluded: false,
      usageBasis: 'retained-scoring-transcript',
      recordedTurns: usage.recordedTurns ?? usage.turns ?? 0,
      retainedTurns: usage.turns ?? 0,
      discardedTurns: usage.discardedTurns ?? 0,
      discardedTurnAllocation:
        (usage.discardedTurns ?? 0) > 0
          ? 'attempt usage prorated by retained/recorded model turns'
          : 'none',
    },
  };
}

export function attemptEndEvents(events) {
  const ends = [];
  let attemptActive = false;
  for (const event of events) {
    if (event.type === 'run_start' || event.type === 'run_resume') {
      attemptActive = true;
    } else if (event.type === 'run_end' && attemptActive) {
      ends.push(event);
      attemptActive = false;
    }
  }
  return ends;
}

export function aggregateAttemptUsage(events) {
  const totals = {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    thinkingTokens: 0,
    costUsd: null,
  };
  let reportedCost = 0;
  let hasReportedCost = false;
  for (const end of attemptEndEvents(events)) {
    const usage = end.usage ?? {};
    for (const key of [
      'turns',
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'thinkingTokens',
    ]) {
      totals[key] += tokenCount(usage[key], key);
    }
    if (usage.costUsd != null) {
      reportedCost += usage.costUsd;
      hasReportedCost = true;
    }
    if (usage.resolvedModel) totals.resolvedModel = usage.resolvedModel;
  }
  totals.costUsd = hasReportedCost ? reportedCost : null;
  return totals;
}

// Cost the transcript that survived repair, rather than every request that
// happened before repair. Token totals exist only at attempt granularity, so
// an attempt with removed model_turn events is prorated by retained turns.
export function aggregateScoringUsage(events) {
  const repaired = events.some(
    (event) =>
      event.type === 'log_compaction' && (event.droppedModelTurns ?? 0) > 0,
  );
  if (!repaired) {
    const usage = aggregateAttemptUsage(events);
    return {
      ...usage,
      recordedTurns: usage.turns,
      discardedTurns: 0,
    };
  }

  const attempts = [];
  let attempt = null;
  for (const event of events) {
    if (event.type === 'run_start' || event.type === 'run_resume') {
      attempt = { retainedTurns: 0, end: null };
    } else if (event.type === 'model_turn' && attempt !== null) {
      attempt.retainedTurns += 1;
    } else if (event.type === 'run_end' && attempt !== null) {
      attempt.end = event;
      attempts.push(attempt);
      attempt = null;
    }
  }

  const totals = {
    turns: 0,
    recordedTurns: 0,
    discardedTurns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    thinkingTokens: 0,
    costUsd: null,
  };
  let reportedCost = 0;
  let hasReportedCost = false;
  for (const { retainedTurns, end } of attempts) {
    const usage = end.usage ?? {};
    const recordedTurns = tokenCount(usage.turns, 'turns');
    const allocation =
      recordedTurns > 0 ? Math.min(retainedTurns / recordedTurns, 1) : 1;
    totals.turns += retainedTurns;
    totals.recordedTurns += recordedTurns;
    totals.discardedTurns += Math.max(recordedTurns - retainedTurns, 0);
    for (const key of [
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'thinkingTokens',
    ]) {
      totals[key] += tokenCount(usage[key], key) * allocation;
    }
    if (usage.costUsd != null) {
      reportedCost += tokenCount(usage.costUsd, 'costUsd') * allocation;
      hasReportedCost = true;
    }
    if (usage.resolvedModel) totals.resolvedModel = usage.resolvedModel;
  }
  for (const key of [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'thinkingTokens',
  ]) {
    totals[key] = Math.round(totals[key]);
  }
  totals.costUsd = hasReportedCost ? reportedCost : null;
  return totals;
}

async function estimateLog(path) {
  const events = (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const start = events.find((event) => event.type === 'run_start') ?? {};
  const usage = aggregateScoringUsage(events);
  const estimate = estimateOpenAiApiCost(start.model ?? '', usage);
  return estimate ? { path, tag: start.tag ?? path, usage, estimate } : null;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    throw new Error('Usage: node src/cost-estimator.js <run.jsonl> [...]');
  }
  for (const path of paths) {
    const result = await estimateLog(path);
    if (result === null) {
      console.log(`${path}: no matching OpenAI price`);
      continue;
    }
    console.log(
      `${result.tag}: ~$${result.estimate.totalUsd.toFixed(4)} API-equivalent`,
    );
  }
}
