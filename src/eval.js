// Runs a models × trials eval matrix sequentially, then prints the report.
// Each run gets a fixed move budget and a per-trial RNG seed shared across
// models, so trial k is the same game for every model.
//
// Usage: node src/eval.js --models haiku,sonnet --trials 3 --moves 300
//        [--provider claude-cli] [--max-minutes 30] [--name my-eval]
//        [--seeds 2,3]  -- rerun specific trials into an existing batch
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
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
    'max-minutes': { type: 'string', default: '30' },
    name: { type: 'string' },
    seeds: { type: 'string' },
  },
});

const models = values.models
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
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
    `Eval batch "${batchName}": models [${models.join(', ')}] × trials [${trialNumbers.join(', ')}], ` +
      `${moves} moves each, provider ${values.provider}\nLogs: ${batchDir}`,
  ),
);

for (const model of models) {
  for (const trial of trialNumbers) {
    const tag = `${model}-t${trial}`;
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
    for (const line of text.trim().split('\n')) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === 'run_end' && event.budgetReached) return true;
    }
  }
  return false;
}

// Runs one harness process to completion, with a wall-clock safety limit.
function runOne(model, trial, tag) {
  return new Promise((resolve) => {
    const logFd = openSync(join(batchDir, `${tag}.log`), 'w');
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('index.js', import.meta.url))],
      {
        env: {
          ...process.env,
          LLM_PROVIDER: values.provider,
          CLAUDE_CLI_MODEL: model,
          ANTHROPIC_MODEL: model,
          MAX_MOVES: String(moves),
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
