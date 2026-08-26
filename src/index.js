import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { styleText } from 'node:util';
import { createAgent } from './agent.js';
import { setup } from './zork.js';

try {
  process.loadEnvFile();
} catch {
  // No .env file — rely on the ambient environment.
}

const LOG_DIR = new URL('../logs/', import.meta.url);

// Consecutive turns without a submitted command before giving up.
const MAX_IDLE_TURNS = 5;
// Consecutive failed model requests (each already retried by the SDK)
// before giving up.
const MAX_REQUEST_FAILURES = 5;

// Zork's parser rejections (bad grammar/vocabulary), as opposed to legal
// commands the world merely refuses ("You can't go that way").
const PARSER_REJECTION =
  /I don't know the word|in a way that I don't understand|That sentence isn't one I recognize|There was no verb in that|noun missing in that sentence|I beg your pardon/;

const systemPrompt = await readFile(
  new URL('system-prompt.txt', import.meta.url),
  'utf8',
);

await main();

async function main() {
  const agent = createAgent({ systemPrompt });
  console.log(
    styleText('blue', `Player backend: ${agent.name} (${agent.model})`),
  );

  const zork = await setup();

  // The interpreter halts when the game truly ends (e.g. the model confirms
  // QUIT, or dies past the end-of-game prompt). In-game text like SCORE
  // output is never treated as the end.
  let halted = false;
  zork.events.on('quit', () => {
    halted = true;
  });

  const runStats = {
    startedAt: Date.now(),
    modelTurns: 0,
    commands: 0,
    parserRejections: 0,
    score: null,
    moves: null,
  };

  let aborted = false;
  // SIGTERM matters too: `timeout`-bounded benchmark runs end with it.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      console.log(`Caught ${signal}, exiting...`);
      aborted = true;
      printRunStats(runStats, agent);
      await writeDebugLog(agent, runStats);
      process.exit(0);
    });
  }

  // Boot the game; the intro is the first thing the model sees. After that,
  // every game output is the result of a command the model submitted.
  const intro = await captureOutput(zork, () => zork.start());
  printGame(intro);
  let pendingOutputs = [toModelText(intro)];
  let idleTurns = 0;
  let requestFailures = 0;

  // The finally releases provider child processes (claude-cli), or the
  // event loop keeps the harness alive after a fatal error.
  try {
    while (!aborted) {
      let turn;
      try {
        turn = await agent.requestCommands(pendingOutputs);
        requestFailures = 0;
      } catch (err) {
        requestFailures += 1;
        console.warn(
          `>>> Model request failed (${requestFailures}/${MAX_REQUEST_FAILURES}): ${err.message}`,
        );
        if (requestFailures >= MAX_REQUEST_FAILURES) {
          await writeDebugLog(agent);
          throw err;
        }
        await sleep(2 ** requestFailures * 1000);
        continue;
      }

      const { commands, commentary } = turn;
      pendingOutputs = [];
      runStats.modelTurns += 1;

      if (commentary) {
        console.log(styleText('magenta', `Player: ${commentary}`));
      }

      if (commands.length === 0) {
        idleTurns += 1;
        if (idleTurns >= MAX_IDLE_TURNS) {
          await writeDebugLog(agent);
          throw new Error(
            `Model produced no command for ${idleTurns} turns in a row.`,
          );
        }
        continue;
      }
      idleTurns = 0;

      let restarted = false;
      for (const command of commands) {
        if (restarted) {
          pendingOutputs.push('(command skipped: the game restarted)');
          continue;
        }
        if (command === '') {
          pendingOutputs.push(
            '(the submit_command call did not include a command)',
          );
          continue;
        }

        console.log(styleText('magenta', `> ${command}`));

        let rawMessages;
        try {
          rawMessages = await zork.input(command);
        } catch (err) {
          console.warn(`>>> Zork error: ${err.message}`);
          pendingOutputs.push(
            `(error: the game failed to run that command: ${err.message})`,
          );
          continue;
        }

        let output = toModelText(rawMessages);
        printGame(rawMessages);
        runStats.commands += 1;
        if (PARSER_REJECTION.test(output)) {
          runStats.parserRejections += 1;
        }

        if (halted) {
          console.log(styleText('green', 'Game over, restarting...'));
          const restartIntro = await captureOutput(zork, () => zork.restart());
          halted = false;
          restarted = true;
          printGame(restartIntro);
          output += `\n(The game has ended and restarted from the beginning.)\n${toModelText(restartIntro)}`;
        }

        pendingOutputs.push(output);
      }

      await probeScore(zork, runStats, restarted);
    }
  } finally {
    agent.dispose?.();
    printRunStats(runStats, agent);
  }
}

// Silently asks the game for the current score after each model turn. The
// model never sees this exchange — it's harness instrumentation only.
async function probeScore(zork, runStats, restarted) {
  if (restarted) return;
  let response;
  try {
    response = toModelText(await zork.input('SCORE'));
  } catch {
    return;
  }
  const match = response.match(/Your score is (-?\d+).*?in (\d+) moves/s);
  if (!match) return;
  const score = Number(match[1]);
  const moves = Number(match[2]);
  if (score !== runStats.score) {
    console.log(styleText('cyan', `[score: ${score}, moves: ${moves}]`));
  }
  runStats.score = score;
  runStats.moves = moves;
}

function printRunStats(runStats, agent) {
  const wallSeconds = Math.round((Date.now() - runStats.startedAt) / 1000);
  const lines = [
    `wall: ${wallSeconds}s | model turns: ${runStats.modelTurns} | commands: ${runStats.commands} (parser rejections: ${runStats.parserRejections})`,
    `score: ${runStats.score ?? '(unknown)'} in ${runStats.moves ?? '?'} moves`,
  ];
  const usage = agent.stats?.();
  if (usage) {
    const pct = (n) => `${Math.round(n * 100)}%`;
    const cachedShare =
      usage.cacheReadTokens / (usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens || 1);
    lines.push(
      `tokens in: ${usage.inputTokens} uncached + ${usage.cacheReadTokens} cache reads + ${usage.cacheWriteTokens} cache writes (${pct(cachedShare)} cached) | tokens out: ${usage.outputTokens}`,
    );
    if (usage.costUsd) {
      lines.push(
        `est. cost at API list prices: $${usage.costUsd.toFixed(2)}${usage.apiMs ? ` | api time: ${Math.round(usage.apiMs / 1000)}s` : ''}`,
      );
    }
  }
  console.log(styleText('cyan', `=== Run stats ===\n${lines.join('\n')}`));
}

// Collects everything the game prints while running an action.
async function captureOutput(zork, action) {
  const messages = [];
  const onPrint = (msg) => messages.push(msg);
  zork.events.on('print', onPrint);
  try {
    await action();
  } finally {
    zork.events.off('print', onPrint);
  }
  return messages;
}

// The z-machine emits HTML-ish markup; the model gets plain text.
function toModelText(rawMessages) {
  return rawMessages
    .join('\n')
    .replaceAll('<span>></span>', '')
    .replaceAll('<br>', '\n')
    .replace(/<\/?span[^>]*>/g, '')
    .trim();
}

// The terminal gets the same text with room names bold and objects underlined.
function printGame(rawMessages) {
  const formatted = rawMessages
    .join('\n')
    .replaceAll('<span>></span>', '')
    .replaceAll('<br>', '\n')
    .replaceAll('<span class="room">', '\x1b[1m')
    .replaceAll('<span class="object">', '\x1b[4m')
    .replaceAll('<span>', '')
    .replaceAll('</span>', '\x1b[0m')
    .trim();
  console.log(styleText('white', `Game: ${formatted}`));
}

async function writeDebugLog(agent, runStats = null) {
  const timestamp = new Date().toISOString().replaceAll(':', '-');
  const debugLogUrl = new URL(`debug-${timestamp}.json`, LOG_DIR);
  await mkdir(LOG_DIR, { recursive: true });
  const payload = { run: runStats, usage: agent.stats?.() ?? null, history: agent.history() };
  await writeFile(debugLogUrl, JSON.stringify(payload, null, 2));
  console.warn(`>>> Debug log written to: ${debugLogUrl.pathname}`);
}
