// Aggregates an eval batch's run-*.jsonl event logs into a comparison table.
// Usage: node src/eval-report.js [logs/eval-<name> ...] [--out <dir>]
//        (no argument: the latest batch)
//
// Several batch directories can be reported together, so models run in
// separate batches — a different harness, or a later top-up — still land in
// one table. A combined report writes summary.json only where --out says to,
// so it cannot overwrite a single batch's own summary.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Reports one batch directory, writing its summary.json back into it.
export async function reportDirectory(dir) {
  return reportDirectories([dir], dir);
}

// Reads one batch directory's completed and incomplete runs into rows.
async function collectRows(dir) {
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
    // A resumed run logs a run_end per interrupted attempt before the real
    // one, so the completion wins; otherwise take the first, since a later
    // one comes from signal cleanup and would count shutdown as play time.
    const end =
      events.findLast((e) => e.type === 'run_end' && e.budgetReached) ??
      events.find((e) => e.type === 'run_end');
    // A run only counts if it spent its whole move budget: a run stopped by
    // a signal still writes run_end, and mixing it in would understate the
    // model. Older logs predate endReason, so fall back to the move count.
    const budgetReached =
      end?.budgetReached ??
      (end && start.moveBudget
        ? (end.runStats.totalMoves || end.runStats.moves || 0) >= start.moveBudget
        : false);
    if (!end || !budgetReached) {
      rows.push({
        model: start.model ?? '?',
        provider: start.provider ?? '?',
        tag: start.tag ?? file,
        incomplete: true,
        endReason: end ? (end.endReason ?? 'stopped early') : 'no run_end',
      });
      continue;
    }
    const s = end.runStats;
    const u = end.usage ?? {};
    const scores = events.filter((e) => e.type === 'score').map((e) => e.score);
    rows.push({
      // Runs group by the alias they requested, so a batch stays one row
      // even though older logs predate exact ids; the row is then labeled
      // with the exact model the API served, when any run recorded it.
      model: start.model ?? '?',
      resolvedModel: u.resolvedModel ?? null,
      provider: start.provider ?? '?',
      tag: start.tag ?? file,
      seed: start.seed ?? null,
      // Time actually spent playing: a resumed run is idle between attempts,
      // so sum each attempt rather than spanning first event to last.
      wallMin: activeMs(events) / 60000,
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
      // Subscription backends report tokens but no price; null means "no
      // cost data", which is not the same as a run that cost nothing.
      costUsd: u.costUsd ?? null,
    });
  }
  return rows;
}

export async function reportDirectories(dirs, outDir = null) {
  const rows = (await Promise.all(dirs.map(collectRows))).flat();

  const columns = [
    ['run', (r) => r.tag],
    ['backend', (r) => r.provider],
    ['score', (r) => (r.incomplete ? `INCOMPLETE(${r.endReason})` : r.maxScore)],
    ['moves', (r) => r.moves],
    ['cmds', (r) => r.commands],
    ['rej', (r) => r.parserRejections],
    ['refus', (r) => r.worldRefusals],
    ['deaths', (r) => r.deaths],
    ['stale', (r) => r.staleness],
    ['wall(m)', (r) => r.wallMin?.toFixed(1)],
    ['out-tok', (r) => r.tokensOut],
    ['cost($)', (r) => r.costUsd?.toFixed(2) ?? 'n/a'],
  ];
  printTable(columns, rows);

  const byModel = Map.groupBy(
    rows.filter((r) => !r.incomplete),
    (r) => r.model,
  );
  const aggregates = [...byModel.entries()].map(([model, runs]) => {
    // Only runs that reported a price contribute to the money columns; a
    // subscription backend reports none, so its cost columns stay null
    // rather than averaging in zeros and inflating score-per-dollar.
    const costed = runs.filter((r) => r.costUsd != null);
    return {
      model: runs.find((r) => r.resolvedModel)?.resolvedModel ?? model,
      alias: model,
      provider: runs[0]?.provider ?? '?',
      trials: runs.length,
      medianScore: median(runs.map((r) => r.maxScore ?? 0)),
      meanScore: mean(runs.map((r) => r.maxScore ?? 0)),
      meanCommands: mean(runs.map((r) => r.commands)),
      meanWallMin: mean(runs.map((r) => r.wallMin)),
      meanCostUsd: costed.length > 0 ? mean(costed.map((r) => r.costUsd)) : null,
      scorePerDollar:
        costed.length > 0
          ? sum(costed.map((r) => r.maxScore ?? 0)) /
            (sum(costed.map((r) => r.costUsd)) || 1)
          : null,
    };
  });
  console.log('\nPer-model aggregates:');
  printTable(
    [
      ['model', (a) => a.model],
      ['backend', (a) => a.provider],
      ['trials', (a) => a.trials],
      ['median score', (a) => a.medianScore],
      ['mean score', (a) => a.meanScore.toFixed(1)],
      ['mean cmds', (a) => a.meanCommands.toFixed(0)],
      ['mean wall(m)', (a) => a.meanWallMin.toFixed(1)],
      ['mean cost($)', (a) => a.meanCostUsd?.toFixed(2) ?? 'n/a'],
      ['score/$', (a) => a.scorePerDollar?.toFixed(1) ?? 'n/a'],
    ],
    aggregates,
  );

  if (outDir !== null) {
    const summaryPath = join(outDir, 'summary.json');
    await writeFile(summaryPath, JSON.stringify({ rows, aggregates }, null, 2));
    console.log(`\nSummary written to ${summaryPath}`);
  }
  return { rows, aggregates };
}

// Sums each play period: run_start/run_resume until that attempt's run_end,
// so the gaps while a run was dead are not counted as play time.
function activeMs(events) {
  let total = 0;
  let startedAt = null;
  for (const event of events) {
    if (event.type === 'run_start' || event.type === 'run_resume') {
      startedAt = event.t;
    } else if (event.type === 'run_end' && startedAt !== null) {
      total += event.t - startedAt;
      startedAt = null;
    }
  }
  // An attempt that never wrote run_end (hard kill) ends at its last event.
  if (startedAt !== null) total += events.at(-1).t - startedAt;
  return total;
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
  const argv = process.argv.slice(2);
  const outFlag = argv.indexOf('--out');
  const outDir = outFlag === -1 ? null : argv[outFlag + 1];
  const dirs = argv.filter(
    (arg, i) =>
      !arg.startsWith('--') && (outFlag === -1 || (i !== outFlag && i !== outFlag + 1)),
  );
  if (dirs.length === 0) {
    const logsDir = fileURLToPath(new URL('../logs/', import.meta.url));
    const batches = (await readdir(logsDir))
      .filter((f) => f.startsWith('eval-'))
      .sort();
    if (batches.length === 0) {
      console.error('No logs/eval-* batches found.');
      process.exit(1);
    }
    dirs.push(join(logsDir, batches.at(-1)));
  }
  // A single batch keeps its summary.json; a combined report writes one only
  // where it is asked to, so it never clobbers a batch's own summary.
  await reportDirectories(dirs, outDir ?? (dirs.length === 1 ? dirs[0] : null));
}
