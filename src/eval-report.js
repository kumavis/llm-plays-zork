// Aggregates an eval batch's run-*.jsonl event logs into a comparison table.
// Usage: node src/eval-report.js [logs/eval-<name>]  (defaults to the latest batch)
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function reportDirectory(dir) {
  const files = (await readdir(dir))
    .filter((f) => f.startsWith('run-') && f.endsWith('.jsonl'))
    .sort();

  const rows = [];
  for (const file of files) {
    const text = await readFile(join(dir, file), 'utf8');
    const events = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const start = events.find((e) => e.type === 'run_start') ?? {};
    const end = events.findLast((e) => e.type === 'run_end');
    if (!end) {
      rows.push({
        model: start.model ?? '?',
        tag: start.tag ?? file,
        incomplete: true,
      });
      continue;
    }
    const s = end.runStats;
    const u = end.usage ?? {};
    const scores = events.filter((e) => e.type === 'score').map((e) => e.score);
    rows.push({
      model: start.model ?? '?',
      tag: start.tag ?? file,
      seed: start.seed ?? null,
      wallMin: (end.t - events[0].t) / 60000,
      turns: s.modelTurns,
      commands: s.commands,
      moves: s.totalMoves || s.moves,
      maxScore: s.maxScore ?? (scores.length > 0 ? Math.max(...scores) : null),
      parserRejections: s.parserRejections,
      worldRefusals: s.worldRefusals,
      deaths: s.deaths,
      staleness: Math.max(
        s.maxCommandsWithoutScore ?? 0,
        (s.commands ?? 0) - (s.commandsAtLastScoreChange ?? 0),
      ),
      tokensOut: u.outputTokens ?? null,
      costUsd: u.costUsd ?? null,
    });
  }

  const columns = [
    ['run', (r) => r.tag],
    ['score', (r) => (r.incomplete ? 'INCOMPLETE' : r.maxScore)],
    ['moves', (r) => r.moves],
    ['cmds', (r) => r.commands],
    ['rej', (r) => r.parserRejections],
    ['refus', (r) => r.worldRefusals],
    ['deaths', (r) => r.deaths],
    ['stale', (r) => r.staleness],
    ['wall(m)', (r) => r.wallMin?.toFixed(1)],
    ['out-tok', (r) => r.tokensOut],
    ['cost($)', (r) => r.costUsd?.toFixed(2)],
  ];
  printTable(columns, rows);

  const byModel = Map.groupBy(
    rows.filter((r) => !r.incomplete),
    (r) => r.model,
  );
  const aggregates = [...byModel.entries()].map(([model, runs]) => ({
    model,
    trials: runs.length,
    medianScore: median(runs.map((r) => r.maxScore ?? 0)),
    meanScore: mean(runs.map((r) => r.maxScore ?? 0)),
    meanCommands: mean(runs.map((r) => r.commands)),
    meanWallMin: mean(runs.map((r) => r.wallMin)),
    meanCostUsd: mean(runs.map((r) => r.costUsd ?? 0)),
    scorePerDollar:
      sum(runs.map((r) => r.maxScore ?? 0)) /
      (sum(runs.map((r) => r.costUsd ?? 0)) || 1),
  }));
  console.log('\nPer-model aggregates:');
  printTable(
    [
      ['model', (a) => a.model],
      ['trials', (a) => a.trials],
      ['median score', (a) => a.medianScore],
      ['mean score', (a) => a.meanScore.toFixed(1)],
      ['mean cmds', (a) => a.meanCommands.toFixed(0)],
      ['mean wall(m)', (a) => a.meanWallMin.toFixed(1)],
      ['mean cost($)', (a) => a.meanCostUsd.toFixed(2)],
      ['score/$', (a) => a.scorePerDollar.toFixed(1)],
    ],
    aggregates,
  );

  const summaryPath = join(dir, 'summary.json');
  await writeFile(summaryPath, JSON.stringify({ rows, aggregates }, null, 2));
  console.log(`\nSummary written to ${summaryPath}`);
  return { rows, aggregates };
}

function printTable(columns, rows) {
  const cells = rows.map((row) =>
    columns.map(([, get]) => String(get(row) ?? '?')),
  );
  const widths = columns.map(([name], i) =>
    Math.max(name.length, ...cells.map((row) => row[i].length)),
  );
  const line = (parts) => parts.map((p, i) => p.padEnd(widths[i])).join('  ');
  console.log(line(columns.map(([name]) => name)));
  console.log(line(widths.map((w) => '-'.repeat(w))));
  for (const row of cells) console.log(line(row));
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length > 0 ? sum(xs) / xs.length : 0);
function median(xs) {
  const sorted = [...xs].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Invoked directly: report on the given directory, or the latest eval batch.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  let dir = process.argv[2];
  if (!dir) {
    const logsDir = fileURLToPath(new URL('../logs/', import.meta.url));
    const batches = (await readdir(logsDir))
      .filter((f) => f.startsWith('eval-'))
      .sort();
    if (batches.length === 0) {
      console.error('No logs/eval-* batches found.');
      process.exit(1);
    }
    dir = join(logsDir, batches.at(-1));
  }
  await reportDirectory(dir);
}
