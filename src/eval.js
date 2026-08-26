// Runs a models × trials eval matrix sequentially, then prints the report.
// Each run gets a fixed move budget and a per-trial RNG seed shared across
// models, so trial k is the same game for every model.
//
// Usage: node src/eval.js --models haiku,sonnet --trials 3 --moves 300
//        [--provider claude-cli] [--max-minutes 30] [--name my-eval]
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
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
  },
});

const models = values.models
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
const trials = Number(values.trials);
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
    `Eval batch "${batchName}": models [${models.join(', ')}] × ${trials} trials, ` +
      `${moves} moves each, provider ${values.provider}\nLogs: ${batchDir}`,
  ),
);

for (const model of models) {
  for (let trial = 1; trial <= trials; trial += 1) {
    const tag = `${model}-t${trial}`;
    console.log(styleText('blue', `--- ${tag} (seed ${trial}) ---`));
    const startedAt = Date.now();
    const code = await runOne(model, trial, tag);
    const minutes = ((Date.now() - startedAt) / 60000).toFixed(1);
    console.log(`${tag}: exit ${code} after ${minutes} min`);
  }
}

await reportDirectory(batchDir);

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
