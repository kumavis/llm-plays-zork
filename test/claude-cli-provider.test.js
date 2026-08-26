import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

// Put the fake `claude` fixture first on PATH before importing the provider.
const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
process.env.PATH = `${fixtures}:${process.env.PATH}`;
const { createClaudeCliProvider } = await import('../src/providers/claude-cli.js');

test('reuses one CLI process across turns and replays the transcript after a crash', async (t) => {
  const provider = createClaudeCliProvider({ systemPrompt: 'You play Zork.' });
  t.after(() => provider.dispose());

  const turn1 = await provider.requestCommands(['West of House']);
  assert.deepEqual(turn1.commands, ['LOOK']);
  const pid1 = turn1.commentary.match(/pid:(\d+)/)[1];
  assert.match(turn1.commentary, /received:West of House/);

  // Second turn rides the same process — no per-turn spawn.
  const turn2 = await provider.requestCommands(['There is a small mailbox here.']);
  const pid2 = turn2.commentary.match(/pid:(\d+)/)[1];
  assert.equal(pid2, pid1);

  // Crash the process: the provider restarts and replays the shadow
  // transcript (the replay is a [Game]-labeled prompt, so it doesn't
  // re-trigger the exact-match DIE).
  const turn3 = await provider.requestCommands(['DIE']);
  assert.deepEqual(turn3.commands, ['LOOK']);
  const pid3 = turn3.commentary.match(/pid:(\d+)/)[1];
  assert.notEqual(pid3, pid1);
  assert.match(turn3.commentary, /received:\[Game\]/);

  // History committed exactly once per turn despite the internal retry.
  assert.equal(provider.history().filter((m) => m.role === 'user').length, 3);

  // Usage accumulated across the three successful exchanges.
  const stats = provider.stats();
  assert.equal(stats.turns, 3);
  assert.equal(stats.inputTokens, 300);
  assert.equal(stats.outputTokens, 30);
  assert.equal(stats.cacheReadTokens, 150);
  assert.ok(Math.abs(stats.costUsd - 0.03) < 1e-9);
});
