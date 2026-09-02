import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { reportDirectories } from '../src/eval-report.js';

// One completed run's event log, as the harness writes it.
function runLog({ model, provider, tag, score, costUsd }) {
  const events = [
    { type: 'run_start', t: 0, provider, model, tag, seed: 1, moveBudget: 10 },
    { type: 'score', t: 1, score },
    {
      type: 'run_end',
      t: 60_000,
      budgetReached: true,
      endReason: 'budget',
      runStats: {
        modelTurns: 10,
        commands: 10,
        totalMoves: 10,
        maxScore: score,
        parserRejections: 0,
        worldRefusals: 0,
        deaths: 0,
      },
      usage: { outputTokens: 100, costUsd, resolvedModel: model },
    },
  ];
  return events.map((e) => JSON.stringify(e)).join('\n');
}

test('reports several batch directories as one table', async () => {
  const a = await mkdtemp(join(tmpdir(), 'eval-a-'));
  const b = await mkdtemp(join(tmpdir(), 'eval-b-'));
  await writeFile(
    join(a, 'run-1-sonnet-t1.jsonl'),
    runLog({ model: 'sonnet', provider: 'claude-cli', tag: 'sonnet-t1', score: 80, costUsd: 2 }),
  );
  await writeFile(
    join(b, 'run-1-sol-t1.jsonl'),
    runLog({ model: 'sol', provider: 'codex-cli', tag: 'sol-t1', score: 60, costUsd: undefined }),
  );

  const { rows, aggregates } = await reportDirectories([a, b]);
  assert.deepEqual(
    rows.map((r) => r.tag),
    ['sonnet-t1', 'sol-t1'],
  );

  const byAlias = new Map(aggregates.map((agg) => [agg.alias, agg]));
  assert.equal(byAlias.get('sonnet').provider, 'claude-cli');
  assert.equal(byAlias.get('sonnet').meanCostUsd, 2);
  assert.equal(byAlias.get('sonnet').scorePerDollar, 40);

  // A subscription backend reports no price: the money columns stay null
  // rather than reading as a free run with infinite value per dollar.
  const codex = byAlias.get('sol');
  assert.equal(codex.provider, 'codex-cli');
  assert.equal(codex.meanCostUsd, null);
  assert.equal(codex.scorePerDollar, null);
  assert.equal(codex.medianScore, 60);
});
