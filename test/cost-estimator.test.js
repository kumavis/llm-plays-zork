import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  aggregateAttemptUsage,
  aggregateScoringUsage,
  attemptEndEvents,
  estimateOpenAiApiCost,
} from '../src/cost-estimator.js';

test('estimates uncached, cached, cache-write, and output token cost', () => {
  const estimate = estimateOpenAiApiCost('gpt-5.6-sol', {
    inputTokens: 1_000_000,
    cacheReadTokens: 750_000,
    cacheWriteTokens: 100_000,
    outputTokens: 50_000,
    thinkingTokens: 40_000,
  });

  // 150K uncached * $4/M + 750K cached * $0.40/M
  // + 100K cache writes * $5/M + 50K output * $20/M.
  assert.equal(estimate.totalUsd, 2.4);
  assert.equal(estimate.tokens.uncachedInput, 150_000);
  assert.equal(estimate.breakdownUsd.output, 1);
  assert.match(estimate.formula, /uncachedInput/);
  assert.equal(estimate.assumptions.reasoningIncludedInOutput, true);
  assert.equal(estimate.assumptions.longContextSurchargeIncluded, false);
});

test('returns null for a model without an explicit price', () => {
  assert.equal(estimateOpenAiApiCost('unknown-model', {}), null);
});

test('sums one usage record per interrupted attempt', () => {
  const events = [
    { type: 'run_start' },
    {
      type: 'run_end',
      usage: { turns: 2, inputTokens: 100, costUsd: 1 },
    },
    // Duplicate signal cleanup for the already-ended attempt is ignored.
    {
      type: 'run_end',
      usage: { turns: 2, inputTokens: 100, costUsd: 1 },
    },
    { type: 'run_resume' },
    {
      type: 'run_end',
      usage: { turns: 3, inputTokens: 200, costUsd: 2 },
    },
  ];

  assert.equal(attemptEndEvents(events).length, 2);
  assert.deepEqual(aggregateAttemptUsage(events), {
    turns: 5,
    inputTokens: 300,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    thinkingTokens: 0,
    costUsd: 3,
  });
});

test('drops estimated usage for turns removed from the scoring transcript', () => {
  const events = [
    { type: 'run_start' },
    { type: 'model_turn' },
    { type: 'model_turn' },
    // The repaired transcript has only two of the four recorded turns.
    {
      type: 'run_end',
      usage: {
        turns: 4,
        inputTokens: 400,
        outputTokens: 40,
        cacheReadTokens: 200,
        thinkingTokens: 20,
        costUsd: 2,
      },
    },
    { type: 'run_resume' },
    { type: 'model_turn' },
    {
      type: 'run_end',
      usage: {
        turns: 1,
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 50,
        thinkingTokens: 5,
        costUsd: 1,
      },
    },
    { type: 'log_compaction', droppedModelTurns: 2 },
  ];

  assert.deepEqual(aggregateScoringUsage(events), {
    turns: 3,
    recordedTurns: 5,
    discardedTurns: 2,
    inputTokens: 300,
    outputTokens: 30,
    cacheReadTokens: 150,
    cacheWriteTokens: 0,
    thinkingTokens: 15,
    costUsd: 2,
  });
});
