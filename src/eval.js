// Runs a models × trials eval matrix sequentially, then prints the report.
// Each run gets a fixed move budget and a per-trial RNG seed shared across
// models, so trial k is the same game for every model.
//
// Usage: node src/eval.js --models haiku,sonnet --trials 3 --moves 300
//        [--provider claude-cli] [--max-minutes 60] [--max-model-turns 1200]
//        [--name my-eval]
//        [--seeds 2,3]  -- rerun specific trials into an existing batch
//
// A --models entry may name its own backend and reasoning effort, so one
// batch can span harnesses and land in a single report:
//   --models claude-cli:sonnet,codex-cli:gpt-5.6-sol@medium
// The bare form uses --provider and the backend's default effort.
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdir, readdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, styleText } from 'node:util';
import { reportDirectory } from './eval-report.js';

const { values } = parseArgs({
  options: {
    models: { type: 'string', default: 'haiku,sonnet' },
    trials: { type: 'string', default: '3' },
    moves: { type: 'string', default: '300' },
    provider: { type: 'string', default: 'claude-cli' },
    'max-minutes': { type: 'string', default: '60' },
    'max-model-turns': { type: 'string' },
    name: { type: 'string' },
    seeds: { type: 'string' },
  },
});

// "[provider:]model[@effort]" — a backend and reasoning effort may travel
// with the model, so a batch can mix harnesses. The model name alone is the
// run's tag and the report's row, since names don't collide across backends.
const models = values.models
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const [head, effort = null] = entry.split('@');
    const colon = head.indexOf(':');
    return colon === -1
      ? { provider: values.provider, name: head, effort }
      : { provider: head.slice(0, colon), name: head.slice(colon + 1), effort };
  });
// Trial index doubles as the RNG seed, so every model plays the same game in
// trial k. --seeds reruns just those trials (e.g. after a failed run).
const trialNumbers = values.seeds
  ? values.seeds.split(',').map((s) => Number(s.trim())).filter(Number.isFinite)
  : Array.from({ length: Number(values.trials) }, (_, i) => i + 1);
const moves = Number(values.moves);
const maxRunMs = Number(values['max-minutes']) * 60 * 1000;
const batchName =
  values.name ?? new Date().toISOString().replaceAll(':', '-').slice(0, 19);
const batchDir = fileURLToPath(
  new URL(`../logs/eval-${batchName}/`, import.meta.url),
);
await mkdir(batchDir, { recursive: true });

console.log(
  styleText(
    'blue',
    `Eval batch "${batchName}": ` +
      `models [${models.map(describe).join(', ')}] × trials [${trialNumbers.join(', ')}], ` +
      `${moves} moves each\nLogs: ${batchDir}`,
  ),
);

for (const model of models) {
  for (const trial of trialNumbers) {
    const tag = `${model.name}-t${trial}`;
    // Resume: a trial that already spent its budget is left alone, so an
    // interrupted batch can be relaunched with the same command.
    if (await isTrialComplete(tag)) {
      console.log(styleText('blue', `--- ${tag}: already complete, skipping ---`));
      continue;
    }
    console.log(styleText('blue', `--- ${tag} (seed ${trial}) ---`));
    const startedAt = Date.now();
    const code = await runOne(model, trial, tag);
    const minutes = ((Date.now() - startedAt) / 60000).toFixed(1);
    console.log(`${tag}: exit ${code} after ${minutes} min`);
    // The terminal log takes its final name only if the run finished, the
    // same rule the harness applies to the event log.
    if (await isTrialComplete(tag)) {
      await rename(
        join(batchDir, `${tag}.log.partial`),
        join(batchDir, `${tag}.log`),
      );
    }
  }
}

await reportDirectory(batchDir);

// True when this trial already has an event log that spent its move budget.
async function isTrialComplete(tag) {
  const logs = (await readdir(batchDir)).filter(
    (f) => f.startsWith('run-') && f.endsWith(`-${tag}.jsonl`),
  );
  for (const log of logs) {
    const text = await readFile(join(batchDir, log), 'utf8');
    const events = text
      .trim()
      .split('\n')
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    // A resumed run writes one run_end per interrupted attempt before the
    // completing one, so every run_end has to be considered — checking only
    // the first would see an interrupted attempt and replay a finished trial.
    for (const end of events.filter((e) => e.type === 'run_end')) {
      if (end.budgetReached) return true;
      // Logs written before run_end carried budgetReached fall back to the
      // move count, matching how the report decides a run is complete.
      if (end.budgetReached === undefined) {
        const played = end.runStats?.totalMoves || end.runStats?.moves || 0;
        if (played >= moves) return true;
      }
    }
  }
  return false;
}

// A model spec as written on the command line, for the batch banner.
function describe({ provider, name, effort }) {
  return `${provider}:${name}${effort ? `@${effort}` : ''}`;
}

// Runs one harness process to completion, with a wall-clock safety limit.
function runOne(model, trial, tag) {
  return new Promise((resolve) => {
    const logFd = openSync(join(batchDir, `${tag}.log.partial`), 'w');
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('index.js', import.meta.url))],
      {
        env: {
          ...process.env,
          LLM_PROVIDER: model.provider,
          // Each backend reads its own model variable, and only the selected
          // one is consulted, so setting all three is harmless.
          CLAUDE_CLI_MODEL: model.name,
          CODEX_CLI_MODEL: model.name,
          ANTHROPIC_MODEL: model.name,
          ...(model.effort
            ? { CODEX_CLI_EFFORT: model.effort, ANTHROPIC_EFFORT: model.effort }
            : {}),
          MAX_MOVES: String(moves),
          ...(values['max-model-turns']
            ? { MAX_MODEL_TURNS: values['max-model-turns'] }
            : {}),
          ZORK_SEED: String(trial),
          RUN_TAG: tag,
          LOG_DIR: batchDir,
        },
        stdio: ['ignore', logFd, logFd],
      },
    );
    const killer = setTimeout(() => {
      console.warn(
        `${tag}: hit the ${values['max-minutes']}-minute wall limit, stopping.`,
      );
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 30000).unref();
    }, maxRunMs);
    child.on('exit', (code) => {
      clearTimeout(killer);
      closeSync(logFd);
      resolve(code);
    });
  });
}
