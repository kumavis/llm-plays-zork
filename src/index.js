import { execSync } from 'node:child_process';
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { styleText } from 'node:util';
import { createAgent } from './agent.js';
import { setup } from './zork.js';

try {
  process.loadEnvFile();
} catch {
  // No .env file — rely on the ambient environment.
}

// LOG_DIR env lets the eval runner group a batch's logs in one directory.
const LOG_DIR = process.env.LOG_DIR
  ? pathToFileURL(process.env.LOG_DIR.replace(/\/?$/, '/'))
  : new URL('../logs/', import.meta.url);

// Eval knobs: stop cleanly after this many game moves (MAX_MOVES), pin the
// game's RNG (ZORK_SEED), and tag the run's logs (RUN_TAG).
const MOVE_BUDGET = Number(process.env.MAX_MOVES) || null;
const SEED =
  process.env.ZORK_SEED !== undefined
    ? Number(process.env.ZORK_SEED)
    : undefined;
const RUN_TAG = process.env.RUN_TAG || null;

// Consecutive turns without a submitted command before giving up.
const MAX_IDLE_TURNS = 5;
// Consecutive failed model requests (each already retried by the SDK)
// before giving up.
const MAX_REQUEST_FAILURES = 5;

// Zork's parser rejections (bad grammar/vocabulary), as opposed to legal
// commands the world merely refuses ("You can't go that way").
const PARSER_REJECTION =
  /I don't know the word|in a way that I don't understand|That sentence isn't one I recognize|There was no verb in that|noun missing in that sentence|I beg your pardon/;
// Legal commands the world refuses — exploration cost, not model error.
const WORLD_REFUSAL =
  /You can't go that way|There is a wall|You can't see any|You can't do that|Which .* do you mean/;
const DARKNESS = /pitch black/;
const DEATH = /You have died|You are dead/;

const systemPrompt = await readFile(
  new URL('system-prompt.txt', import.meta.url),
  'utf8',
);

await main();
// Backstop: exit even if something still holds the event loop open. Every
// log write is awaited before main() returns, so nothing is lost.
process.exit(0);

async function main() {
  const agent = createAgent({ systemPrompt });
  console.log(
    styleText('blue', `Player backend: ${agent.name} (${agent.model})`),
  );

  const zork = await setup({ seed: SEED });

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
    worldRefusals: 0,
    darknessWarnings: 0,
    deaths: 0,
    gameRestarts: 0,
    score: null,
    maxScore: null,
    moves: null,
    // Moves spent in earlier lives: the in-game counter resets on restart,
    // so budgets and reports use movesBeforeRestarts + moves.
    movesBeforeRestarts: 0,
    totalMoves: 0,
    // Staleness: the longest stretch of commands with no score change.
    commandsAtLastScoreChange: 0,
    maxCommandsWithoutScore: 0,
    turnLatenciesMs: [],
  };

  // Machine-readable event log for offline analysis (metrics, state-graph
  // reconstruction) — one JSON object per line. The terminal log stays for
  // humans. Writes are chained so lines never interleave.
  // A run in flight writes a .partial file and only takes its final name
  // once it has spent its move budget, so an interrupted run is never
  // mistaken for a result — on disk or in git.
  await mkdir(LOG_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(':', '-');
  const eventLogUrl = new URL(
    `run-${timestamp}${RUN_TAG ? `-${RUN_TAG}` : ''}.jsonl`,
    LOG_DIR,
  );
  const partialLogUrl = new URL(`${eventLogUrl.href}.partial`);
  let eventLogChain = Promise.resolve();
  const logEvent = (type, data) => {
    const line = `${JSON.stringify({ t: Date.now(), type, ...data })}\n`;
    eventLogChain = eventLogChain.then(() => appendFile(partialLogUrl, line));
  };
  logEvent('run_start', {
    provider: agent.name,
    model: agent.model,
    tag: RUN_TAG,
    seed: SEED ?? null,
    moveBudget: MOVE_BUDGET,
    harnessCommit: gitCommit(),
  });
  console.log(styleText('blue', `Event log: ${partialLogUrl.pathname}`));

  let aborted = false;
  // SIGTERM matters too: `timeout`-bounded benchmark runs end with it.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      console.log(`Caught ${signal}, exiting...`);
      aborted = true;
      printRunStats(runStats, agent);
      logEvent('run_end', {
        endReason: signal,
        budgetReached: false,
        runStats,
        usage: agent.stats?.() ?? null,
      });
      await eventLogChain;
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
  // Whether the run ended by spending its move budget, as opposed to a
  // signal or error. Only budget-complete runs are comparable in a report.
  let budgetReached = false;

  // The finally releases provider child processes (claude-cli), or the
  // event loop keeps the harness alive after a fatal error.
  try {
    while (!aborted) {
      let turn;
      const requestStartedAt = Date.now();
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
      runStats.turnLatenciesMs.push(Date.now() - requestStartedAt);
      logEvent('model_turn', {
        turn: runStats.modelTurns,
        latencyMs: Date.now() - requestStartedAt,
        commands,
        commentary,
      });

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
        const rejected = PARSER_REJECTION.test(output);
        const refused = WORLD_REFUSAL.test(output);
        if (rejected) runStats.parserRejections += 1;
        if (refused) runStats.worldRefusals += 1;
        if (DARKNESS.test(output)) runStats.darknessWarnings += 1;
        if (DEATH.test(output)) runStats.deaths += 1;
        logEvent('command', {
          turn: runStats.modelTurns,
          command,
          response: output,
          parserRejection: rejected,
          worldRefusal: refused,
        });

        if (halted) {
          console.log(styleText('green', 'Game over, restarting...'));
          const restartIntro = await captureOutput(zork, () => zork.restart());
          halted = false;
          restarted = true;
          runStats.gameRestarts += 1;
          runStats.movesBeforeRestarts += runStats.moves ?? 0;
          runStats.moves = 0;
          runStats.score = null;
          logEvent('game_restart', { turn: runStats.modelTurns });
          printGame(restartIntro);
          output += `\n(The game has ended and restarted from the beginning.)\n${toModelText(restartIntro)}`;
        }

        pendingOutputs.push(output);
      }

      await probeScore(zork, runStats, restarted, logEvent);

      if (MOVE_BUDGET !== null && runStats.totalMoves >= MOVE_BUDGET) {
        console.log(
          styleText(
            'green',
            `Move budget of ${MOVE_BUDGET} reached, ending run.`,
          ),
        );
        budgetReached = true;
        break;
      }
    }
  } finally {
    agent.dispose?.();
    printRunStats(runStats, agent);
    logEvent('run_end', {
      endReason: budgetReached ? 'budget' : 'stopped',
      budgetReached,
      runStats,
      usage: agent.stats?.() ?? null,
    });
    await eventLogChain;
    if (budgetReached) await rename(partialLogUrl, eventLogUrl);
  }
}

// Silently asks the game for the current score after each model turn. The
// model never sees this exchange — it's harness instrumentation only.
async function probeScore(zork, runStats, restarted, logEvent) {
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
    logEvent('score', { score, moves, commands: runStats.commands });
    runStats.maxScore = Math.max(runStats.maxScore ?? score, score);
    runStats.maxCommandsWithoutScore = Math.max(
      runStats.maxCommandsWithoutScore,
      runStats.commands - runStats.commandsAtLastScoreChange,
    );
    runStats.commandsAtLastScoreChange = runStats.commands;
  }
  runStats.score = score;
  runStats.moves = moves;
  runStats.totalMoves = runStats.movesBeforeRestarts + moves;
}

function printRunStats(runStats, agent) {
  const wallSeconds = Math.round((Date.now() - runStats.startedAt) / 1000);
  const latencies = [...runStats.turnLatenciesMs].sort((a, b) => a - b);
  const pctile = (p) =>
    latencies.length > 0
      ? `${(latencies[Math.floor((latencies.length - 1) * p)] / 1000).toFixed(1)}s`
      : '?';
  const staleness = Math.max(
    runStats.maxCommandsWithoutScore,
    runStats.commands - runStats.commandsAtLastScoreChange,
  );
  const lines = [
    `wall: ${wallSeconds}s | model turns: ${runStats.modelTurns} (latency p50 ${pctile(0.5)}, p95 ${pctile(0.95)}) | commands: ${runStats.commands}`,
    `parser rejections: ${runStats.parserRejections} | world refusals: ${runStats.worldRefusals} | darkness warnings: ${runStats.darknessWarnings} | deaths: ${runStats.deaths} | restarts: ${runStats.gameRestarts}`,
    `score: ${runStats.score ?? '(unknown)'} (max ${runStats.maxScore ?? '?'}) in ${runStats.moves ?? '?'} moves | longest scoreless stretch: ${staleness} commands`,
  ];
  const usage = agent.stats?.();
  if (usage?.resolvedModel) {
    lines.push(`model served: ${usage.resolvedModel}`);
  }
  if (usage) {
    const pct = (n) => `${Math.round(n * 100)}%`;
    const cachedShare =
      usage.cacheReadTokens /
      (usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens || 1);
    lines.push(
      `tokens in: ${usage.inputTokens} uncached + ${usage.cacheReadTokens} cache reads + ${usage.cacheWriteTokens} cache writes (${pct(cachedShare)} cached) | tokens out: ${usage.outputTokens}${usage.thinkingTokens ? ` (${usage.thinkingTokens} thinking)` : ''}`,
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

function gitCommit() {
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: new URL('.', import.meta.url).pathname,
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

async function writeDebugLog(agent, runStats = null) {
  const timestamp = new Date().toISOString().replaceAll(':', '-');
  const debugLogUrl = new URL(`debug-${timestamp}.json`, LOG_DIR);
  await mkdir(LOG_DIR, { recursive: true });
  const payload = {
    run: runStats,
    usage: agent.stats?.() ?? null,
    history: agent.history(),
  };
  await writeFile(debugLogUrl, JSON.stringify(payload, null, 2));
  console.warn(`>>> Debug log written to: ${debugLogUrl.pathname}`);
}
