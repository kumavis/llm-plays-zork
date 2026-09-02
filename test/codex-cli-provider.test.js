import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

// Put the fake `codex` fixture first on PATH before importing the provider.
const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
process.env.PATH = `${fixtures}:${process.env.PATH}`;
const { createCodexCliProvider } = await import('../src/providers/codex-cli.js');

test('carries the thread across turns and replays the transcript after a failure', async (t) => {
  const provider = createCodexCliProvider({ systemPrompt: 'You play Zork.' });
  t.after(() => provider.dispose());

  // First turn opens a thread; nothing to resume yet.
  const turn1 = await provider.requestCommands(['West of House']);
  assert.deepEqual(turn1.commands, ['LOOK']);
  assert.match(turn1.commentary, /thread:new/);
  assert.match(turn1.commentary, /received:West of House/);

  // Second turn resumes the thread the first one opened.
  const turn2 = await provider.requestCommands(['There is a small mailbox here.']);
  assert.match(turn2.commentary, /thread:thread-1/);

  // A failed turn drops the thread and retries with the whole transcript
  // replayed into a fresh one (the replay is [Game]-labeled, so it does not
  // re-trigger the exact-match DIE).
  const turn3 = await provider.requestCommands(['DIE']);
  assert.deepEqual(turn3.commands, ['LOOK']);
  assert.match(turn3.commentary, /thread:new/);
  assert.match(turn3.commentary, /received:\[Game\]/);

  // History committed exactly once per turn despite the internal retry.
  assert.equal(provider.history().filter((m) => m.role === 'user').length, 3);

  // Usage accumulated across the three successful exchanges; a subscription
  // run reports tokens but no price.
  const stats = provider.stats();
  assert.equal(stats.turns, 3);
  assert.equal(stats.inputTokens, 300);
  assert.equal(stats.outputTokens, 30);
  assert.equal(stats.cacheReadTokens, 150);
  assert.equal(stats.cacheWriteTokens, 15);
  assert.equal(stats.thinkingTokens, 12);
  assert.equal(stats.costUsd, null);
});
