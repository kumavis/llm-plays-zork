import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

const systemPrompt = await readFile(new URL('system-prompt.txt', import.meta.url), 'utf8');

await main();

async function main() {
  const agent = createAgent({ systemPrompt });
  console.log(styleText('blue', `Player backend: ${agent.name} (${agent.model})`));

  const zork = await setup();

  let aborted = false;
  process.on('SIGINT', async () => {
    console.log('Caught interrupt signal, exiting...');
    aborted = true;
    await writeDebugLog(agent);
    process.exit(0);
  });

  // Boot the game; the intro is the first thing the model sees. After that,
  // every game output is the result of a command the model submitted.
  const intro = await captureOutput(zork, () => zork.start());
  printGame(intro);
  let pendingOutputs = [toModelText(intro)];
  let idleTurns = 0;

  while (!aborted) {
    const { commands, commentary } = await agent.requestCommands(pendingOutputs);
    pendingOutputs = [];

    if (commentary) {
      console.log(styleText('magenta', `Player: ${commentary}`));
    }

    if (commands.length === 0) {
      idleTurns += 1;
      if (idleTurns >= MAX_IDLE_TURNS) {
        await writeDebugLog(agent);
        throw new Error(`Model produced no command for ${idleTurns} turns in a row.`);
      }
      continue;
    }
    idleTurns = 0;

    for (const command of commands) {
      console.log(styleText('magenta', `> ${command}`));

      let rawMessages;
      try {
        rawMessages = await zork.input(command);
      } catch (err) {
        console.warn(`>>> Zork error: ${err.message}`);
        pendingOutputs.push(`(error: the game failed to run that command: ${err.message})`);
        continue;
      }

      let output = toModelText(rawMessages);
      printGame(rawMessages);

      if (output.includes('Your score is ')) {
        console.log(styleText('green', 'Game ended, restarting...'));
        const restartIntro = await captureOutput(zork, () => zork.restart());
        printGame(restartIntro);
        output += `\n(The game has ended and restarted from the beginning.)\n${toModelText(restartIntro)}`;
      }

      pendingOutputs.push(output);
    }
  }
}

// Collects everything the game prints while running an action.
async function captureOutput(zork, action) {
  const messages = [];
  const onPrint = (msg) => messages.push(msg);
  zork.events.on('print', onPrint);
  await action();
  zork.events.off('print', onPrint);
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

async function writeDebugLog(agent) {
  const timestamp = new Date().toISOString().replaceAll(':', '-');
  const debugLogUrl = new URL(`debug-${timestamp}.json`, LOG_DIR);
  await mkdir(LOG_DIR, { recursive: true });
  await writeFile(debugLogUrl, JSON.stringify(agent.history(), null, 2));
  console.warn(`>>> Debug log written to: ${debugLogUrl.pathname}`);
}
