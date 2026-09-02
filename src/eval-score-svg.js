// Renders every completed run as a series in one score-over-moves SVG.
// Usage: node src/eval-score-svg.js [logs/eval-foo ...] [--output path.svg]
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const WIDTH = 1200;
const HEIGHT = 700;
const PLOT = { top: 104, right: 850, bottom: 626, left: 76 };
const LEGEND = { left: 888, top: 116, rowHeight: 51 };
const SCORE_TICK = 50;

const escapeXml = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

const scale = (value, domainMax, rangeStart, rangeEnd) =>
  rangeStart + (value / domainMax) * (rangeEnd - rangeStart);

const ticks = (maximum, step) => {
  const values = [];
  for (let value = 0; value <= maximum; value += step) values.push(value);
  if (values.at(-1) !== maximum) values.push(maximum);
  return values;
};

function stepPath(points, x, y) {
  if (points.length === 0) return '';
  const [first, ...rest] = points;
  let path = `M ${x(first.moves).toFixed(2)} ${y(first.score).toFixed(2)}`;
  for (const point of rest) {
    path += ` H ${x(point.moves).toFixed(2)} V ${y(point.score).toFixed(2)}`;
  }
  return path;
}

function familyFor(start) {
  const identity = `${start.tag ?? ''} ${start.model ?? ''}`.toLowerCase();
  if (identity.includes('haiku')) return 'haiku';
  if (identity.includes('sonnet')) return 'sonnet';
  if (identity.includes('opus')) return 'opus';
  if (identity.includes('sol')) return 'sol';
  if (identity.includes('luna')) return 'luna';
  if (identity.includes('terra')) return 'terra';
  return 'other';
}

function trialFor(tag) {
  return /(?:^|-)t(\d+)(?:$|-)/i.exec(tag)?.[1] ?? '1';
}

function providerFor(start, family) {
  const provider = (start.provider ?? '').toLowerCase();
  if (provider.includes('claude') || provider.includes('anthropic')) {
    return { key: 'anthropic', label: 'Anthropic · strongest → lightest', order: 0 };
  }
  if (provider.includes('codex') || provider.includes('openai')) {
    return { key: 'openai', label: 'OpenAI · strongest → lightest', order: 1 };
  }
  return { key: provider || family, label: start.provider ?? 'Other', order: 2 };
}

function strengthFor(family) {
  return {
    opus: 0,
    sol: 0,
    sonnet: 1,
    terra: 1,
    haiku: 2,
    luna: 2,
  }[family] ?? 99;
}

function labelFor(family, trial) {
  const model = {
    opus: 'Claude Opus 5',
    sonnet: 'Claude Sonnet 5',
    haiku: 'Claude Haiku 4.5',
    sol: 'GPT-5.6 Sol',
    terra: 'GPT-5.6 Terra',
    luna: 'GPT-5.6 Luna',
  }[family];
  return model ? `${model} · t${trial}` : null;
}

export function completedRun(events) {
  const start = events.find((event) => event.type === 'run_start');
  const end = events.filter((event) => event.type === 'run_end').at(-1);
  if (!start || !end) return null;
  const moves = end.runStats?.totalMoves ?? end.runStats?.moves ?? 0;
  const moveBudget = start.moveBudget ?? moves;
  const complete = end.budgetReached ?? moves >= moveBudget;
  return complete ? { start, end, moves, moveBudget } : null;
}

export function scorePoints(events) {
  const points = [];
  let moveOffset = 0;
  let lastGameMoves = 0;
  let lastCommandResponse = '';
  for (const event of events) {
    if (event.type === 'command') {
      lastCommandResponse = event.response ?? '';
    } else if (event.type === 'game_restart') {
      const reportedMoves = /\bin\s+(\d+)\s+moves?\b/i.exec(
        lastCommandResponse,
      )?.[1];
      moveOffset += reportedMoves ? Number(reportedMoves) : lastGameMoves;
      lastGameMoves = 0;
    } else if (
      event.type === 'score' &&
      Number.isFinite(event.moves) &&
      Number.isFinite(event.score)
    ) {
      lastGameMoves = event.moves;
      points.push({ moves: moveOffset + event.moves, score: event.score });
    }
  }
  return points;
}

function seriesFrom(events, sourceName) {
  const run = completedRun(events);
  if (run === null) throw new Error(`${sourceName} is not a completed run`);

  const { start, end, moves } = run;
  const stats = end.runStats ?? {};
  const scores = scorePoints(events);
  const finalScore = stats.score ?? scores.at(-1)?.score ?? 0;
  const points = [{ moves: 0, score: 0 }, ...scores];
  if (points.at(-1).moves !== moves || points.at(-1).score !== finalScore) {
    points.push({ moves, score: finalScore });
  }
  const observedMax = points.reduce(
    (maximum, point) => Math.max(maximum, point.score),
    0,
  );
  const tag = start.tag ?? basename(sourceName, '.jsonl');
  const family = familyFor(start);
  const trial = trialFor(tag);
  return {
    tag,
    label: labelFor(family, trial) ?? tag,
    family,
    provider: providerFor(start, family),
    strength: strengthFor(family),
    trial,
    points,
    finalScore,
    maxScore: stats.maxScore ?? observedMax,
    moveBudget: run.moveBudget,
  };
}

export function renderScoreSvg(runs) {
  if (runs.length === 0) throw new Error('No completed runs to chart');
  const series = runs
    .map(({ events, sourceName }) => seriesFrom(events, sourceName))
    .sort(
      (a, b) =>
        a.provider.order - b.provider.order ||
        a.strength - b.strength ||
        Number(a.trial) - Number(b.trial) ||
        a.tag.localeCompare(b.tag),
    );
  const moveBudget = Math.max(...series.map((run) => run.moveBudget));
  const scoreMaximum = Math.max(...series.map((run) => run.maxScore));
  const yMaximum = Math.max(
    SCORE_TICK,
    Math.ceil(scoreMaximum / SCORE_TICK) * SCORE_TICK,
  );
  const x = (value) => scale(value, moveBudget, PLOT.left, PLOT.right);
  const y = (value) =>
    scale(value, yMaximum, PLOT.bottom, PLOT.top);
  const xTicks = ticks(moveBudget, moveBudget <= 100 ? 20 : 50);
  const yTicks = ticks(yMaximum, SCORE_TICK);

  const horizontalGrid = yTicks
    .map((value) => {
      const py = y(value);
      return `<line class="grid" x1="${PLOT.left}" y1="${py}" x2="${PLOT.right}" y2="${py}"/><text class="tick" x="${PLOT.left - 12}" y="${py + 4}" text-anchor="end">${value}</text>`;
    })
    .join('');
  const verticalGrid = xTicks
    .map((value) => {
      const px = x(value);
      return `<line class="grid" x1="${px}" y1="${PLOT.top}" x2="${px}" y2="${PLOT.bottom}"/><text class="tick" x="${px}" y="${PLOT.bottom + 24}" text-anchor="middle">${value}</text>`;
    })
    .join('');
  const lines = series
    .map(
      (run) => `<path class="score-line family-${run.family} trial-${run.trial}" d="${stepPath(run.points, x, y)}"><title>${escapeXml(run.label)}: final ${run.finalScore}, max ${run.maxScore}</title></path>`,
    )
    .join('\n  ');
  const groups = [];
  for (const run of series) {
    const current = groups.at(-1);
    if (current?.key === run.provider.key) current.runs.push(run);
    else groups.push({ ...run.provider, runs: [run] });
  }
  let legendY = LEGEND.top;
  const legend = groups
    .map((group) => {
      const heading = `<text class="provider-heading" x="${LEGEND.left}" y="${legendY}">${escapeXml(group.label)}</text>`;
      legendY += 26;
      const rows = group.runs
        .map((run) => {
          const row = `<g transform="translate(${LEGEND.left} ${legendY})">
      <line class="legend-line family-${run.family} trial-${run.trial}" x1="0" y1="0" x2="36" y2="0"/>
      <text class="legend-name" x="48" y="4">${escapeXml(run.label)}</text>
      <text class="legend-stat" x="206" y="4">${run.finalScore} / ${run.maxScore}</text>
    </g>`;
          legendY += 28;
          return row;
        })
        .join('\n    ');
      legendY += 10;
      return `${heading}\n    ${rows}`;
    })
    .join('\n    ');
  const description = series
    .map((run) => `${run.label}, final ${run.finalScore}, maximum ${run.maxScore}`)
    .join('; ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-labelledby="title desc">
  <title id="title">Zork score progression — all completed runs</title>
  <desc id="desc">Step line chart of ${series.length} completed Zork runs over ${moveBudget} game moves with a y-axis maximum of ${yMaximum} points. ${escapeXml(description)}.</desc>
  <style>
    :root { color-scheme: light dark; }
    svg { color: #18212f; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .background { fill: #ffffff; }
    .title { fill: currentColor; font-size: 25px; font-weight: 700; }
    .subtitle, .tick, .axis-title, .legend-stat { fill: #516071; }
    .subtitle { font-size: 14px; }
    .tick, .axis-title { font-size: 12px; }
    .axis-title, .legend-name, .provider-heading { font-weight: 600; }
    .legend-name { fill: currentColor; font-size: 13px; }
    .legend-stat { font-size: 12px; }
    .provider-heading { fill: currentColor; font-size: 12px; }
    .grid { stroke: #d9e0e8; stroke-width: 1; }
    .frame { fill: none; stroke: #8d9aaa; stroke-width: 1; }
    .score-line, .legend-line { fill: none; stroke-linejoin: round; stroke-linecap: round; }
    .score-line { stroke-width: 2.5; opacity: 0.88; }
    .legend-line { stroke-width: 3; }
    .score-line.family-haiku, .legend-line.family-haiku { stroke: #b44b9b; }
    .score-line.family-sonnet, .legend-line.family-sonnet { stroke: #167d75; }
    .score-line.family-opus, .legend-line.family-opus { stroke: #d06518; }
    .score-line.family-sol, .legend-line.family-sol { stroke: #2467d1; }
    .score-line.family-luna, .legend-line.family-luna { stroke: #7656c7; }
    .score-line.family-terra, .legend-line.family-terra { stroke: #47821f; }
    .score-line.family-other, .legend-line.family-other { stroke: #677487; }
    .trial-2 { stroke-dasharray: 10 5; }
    .trial-3 { stroke-dasharray: 3 4; }
    @media (prefers-color-scheme: dark) {
      svg { color: #edf2f7; }
      .background { fill: #111722; }
      .subtitle, .tick, .axis-title, .legend-stat { fill: #aeb9c6; }
      .grid { stroke: #2f3947; }
      .frame { stroke: #687587; }
      .score-line.family-haiku, .legend-line.family-haiku { stroke: #ed8bd2; }
      .score-line.family-sonnet, .legend-line.family-sonnet { stroke: #54c9bc; }
      .score-line.family-opus, .legend-line.family-opus { stroke: #f2a05f; }
      .score-line.family-sol, .legend-line.family-sol { stroke: #70a5f9; }
      .score-line.family-luna, .legend-line.family-luna { stroke: #b19aef; }
      .score-line.family-terra, .legend-line.family-terra { stroke: #92ca6c; }
      .score-line.family-other, .legend-line.family-other { stroke: #aeb9c6; }
    }
  </style>
  <rect class="background" width="${WIDTH}" height="${HEIGHT}"/>
  <text class="title" x="${PLOT.left}" y="38">Zork score progression — all completed runs</text>
  <text class="subtitle" x="${PLOT.left}" y="64">${series.length} runs · ${moveBudget} game moves · y-axis maximum ${yMaximum}</text>
  <g>${horizontalGrid}${verticalGrid}</g>
  <rect class="frame" x="${PLOT.left}" y="${PLOT.top}" width="${PLOT.right - PLOT.left}" height="${PLOT.bottom - PLOT.top}"/>
  ${lines}
  <text class="axis-title" x="${(PLOT.left + PLOT.right) / 2}" y="${HEIGHT - 18}" text-anchor="middle">Game moves</text>
  <text class="axis-title" transform="translate(20 ${(PLOT.top + PLOT.bottom) / 2}) rotate(-90)" text-anchor="middle">Score (points)</text>
  <text class="axis-title" x="${LEGEND.left}" y="92">Completed runs · final / max</text>
  ${legend}
</svg>
`;
}

async function findJsonlFiles(inputs) {
  const jsonlFiles = [];
  const visit = async (input) => {
    const entries = await readdir(input, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(input, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name.startsWith('run-') && entry.name.endsWith('.jsonl')) {
        jsonlFiles.push(path);
      }
    }
  };
  for (const input of inputs) await visit(input);
  return jsonlFiles.sort();
}

export async function generateScoreSvg(
  inputs = ['logs'],
  output = 'logs/run-scores.svg',
) {
  const runs = [];
  for (const sourceName of await findJsonlFiles(inputs)) {
    const events = (await readFile(sourceName, 'utf8'))
      .split('\n')
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    if (completedRun(events) !== null) runs.push({ events, sourceName });
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, renderScoreSvg(runs));
  return { output, runCount: runs.length };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf('--output');
  const output = outputIndex >= 0 ? args.splice(outputIndex, 2)[1] : undefined;
  if (outputIndex >= 0 && !output) throw new Error('--output requires a path');
  const result = await generateScoreSvg(
    args.length > 0 ? args : ['logs'],
    output ?? 'logs/run-scores.svg',
  );
  console.log(result.output);
  console.log(`Charted ${result.runCount} completed runs in one SVG.`);
}
