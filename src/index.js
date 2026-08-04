import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { styleText } from 'node:util';
import { createAgent, parseTurn } from './agent.js';
import { setup } from './zork.js';

try {
  process.loadEnvFile();
} catch {
  // No .env file — rely on the ambient environment.
}

const INITIAL_MISSION = 'Get inside the house and then into the cellar under the rug.';
const LOG_DIR = new URL('../logs/', import.meta.url);

const systemPrompt = await readFile(new URL('system-prompt.txt', import.meta.url), 'utf8');

await main();

async function main() {
  const chatHistory = [];
  const agent = createAgent({ systemPrompt });

  let currentMission = INITIAL_MISSION;
  const notes = [];

  const zork = await makeZork(chatHistory);
  printHistory(chatHistory);

  let aborted = false;
  process.on('SIGINT', async () => {
    console.log('Caught interrupt signal, exiting...');
    aborted = true;
    await writeDebugLog(chatHistory);
    process.exit(0);
  });

  while (!aborted) {
    // Ask the model for the next move; on a malformed response, log it and
    // ask again without polluting the chat history.
    const rawResponse = await agent.requestTurn({ chatHistory, currentMission, notes });

    let turn;
    try {
      turn = parseTurn(rawResponse);
    } catch (err) {
      await logInvalidResponse(err, rawResponse, chatHistory);
      continue;
    }

    if (turn.mission) {
      currentMission = turn.mission;
      console.log(styleText('blue', `Mission updated: ${currentMission}`));
    }
    if (turn.note) {
      notes.push(turn.note);
      console.log(styleText('cyan', `Note: ${turn.note}`));
    }

    chatHistory.push({ role: 'assistant', content: rawResponse });

    // Run the command; the game's response is appended to the chat history
    // by the print listener installed in makeZork.
    let messages;
    try {
      messages = await zork.input(turn.command);
    } catch (err) {
      await logZorkError(err, rawResponse, chatHistory);
      continue;
    }

    const didEnd = messages.join('\n').includes('Your score is ');
    if (didEnd) {
      console.log(styleText('green', 'Game ended, restarting...'));
      await zork.restart();
      printHistory(chatHistory.slice(-1));
      currentMission = INITIAL_MISSION;
      continue;
    }

    printRunState({ currentMission, notes });
    printHistory(chatHistory.slice(-2));
  }
}

async function makeZork(chatHistory) {
  const zork = await setup();
  zork.events.on('print', (msg) => {
    // Zork echoes a ">" command prompt, which is not needed in the transcript.
    const formattedMsg = msg.replaceAll('<span>></span>', '');
    const lastChatHistory = chatHistory[chatHistory.length - 1];
    if (lastChatHistory && lastChatHistory.role === 'user') {
      lastChatHistory.content += `\n${formattedMsg}`;
    } else {
      chatHistory.push({ role: 'user', content: formattedMsg });
    }
  });
  await zork.start();
  return zork;
}

async function logInvalidResponse(err, rawResponse, chatHistory) {
  console.warn(`>>> Failed to parse response (${err.message}):\n${JSON.stringify(rawResponse)}`);
  await writeDebugLog(chatHistory);
}

async function logZorkError(err, rawResponse, chatHistory) {
  console.warn(`>>> Zork error: ${err.message}`);
  console.warn(`>>> Agent response:\n${JSON.stringify(rawResponse)}`);
  await writeDebugLog(chatHistory);
}

async function writeDebugLog(chatHistory) {
  const timestamp = new Date().toISOString().replaceAll(':', '-');
  const debugLogUrl = new URL(`debug-${timestamp}.json`, LOG_DIR);
  await mkdir(LOG_DIR, { recursive: true });
  await writeFile(debugLogUrl, JSON.stringify(chatHistory, null, 2));
  console.warn(`>>> Debug log written to: ${debugLogUrl.pathname}`);
}

function printHistory(chatHistory) {
  for (const { role, content } of chatHistory) {
    const formattedContent = htmlToTerminal(content);
    if (role === 'user') {
      console.log(styleText('white', `Game: ${formattedContent}`));
    } else if (role === 'assistant') {
      console.log(styleText('magenta', `Player: ${formatAssistantTurn(content)}`));
    } else {
      console.log(`System: ${formattedContent}`);
    }
  }
}

// Renders a stored assistant turn (raw JSON) as readable thinking + command.
function formatAssistantTurn(content) {
  try {
    const turn = parseTurn(content);
    return turn.thinking ? `${turn.thinking}\n> ${turn.command}` : `> ${turn.command}`;
  } catch {
    return content;
  }
}

function printRunState({ currentMission, notes }) {
  console.log(styleText('yellow', `Mission: ${currentMission}`));
  if (notes.length > 0) {
    console.log(styleText('yellow', `Notes:\n${notes.map((note) => `  - ${note}`).join('\n')}`));
  } else {
    console.log(styleText('yellow', 'Notes: (No notes)'));
  }
}

function htmlToTerminal(input) {
  return input
    .replaceAll('<br>', '\n')
    // Room names render bold, object names underlined.
    .replaceAll('<span class="room">', '\x1b[1m')
    .replaceAll('<span class="object">', '\x1b[4m')
    .replaceAll('<span>', '')
    .replaceAll('</span>', '\x1b[0m');
}
