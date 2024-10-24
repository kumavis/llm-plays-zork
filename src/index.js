import * as fs from 'fs/promises';
import dotenv from 'dotenv';
import { ChatOpenAI } from '@langchain/openai';
import { setup } from './zork.js';

const __dirname = new URL('.', import.meta.url).pathname;

dotenv.config();

const systemPrompt = await fs.readFile(`${__dirname}/system-prompt.txt`, 'utf8');

main()

async function main () {
  let aborted = false;
  const chatHistory = []

  const model = new ChatOpenAI({
    model: process.env.OPENAI_MODEL,
    apiKey: process.env.OPENAI_API_KEY,
    configuration: {
      basePath: process.env.OPENAI_BASE_URL,
    },
  });

  let zork = await makeZork(chatHistory);
  printHistory(chatHistory);

  const initialMission = 'Get inside the house and then into the cellar under the rug.';
  
  // Game runtime state
  let currentMission = initialMission;
  const notes = [];

  process.on('SIGINT', async () => {
    console.log('Caught interrupt signal, exiting...');
    aborted = true;
    writeDebugLog(chatHistory);
    process.exit(0);
  });

  try {
    while (!aborted) {
      // invoke the agent with the chat history
      // and parse the response. if the response
      // cannot be parsed, try again
      const rawResponse = await invokeAgent(model, {
        chatHistory,
        systemPrompt,
        currentMission,
        notes,
      });

      // heuristics for a run-away response
      if (!isAsciiString(rawResponse)) {
        logInvalidResponse(rawResponse, chatHistory);
        continue;
      }
      if (rawResponse.length > 10_000 || rawResponse.split('\n').length > 15) {
        logInvalidResponse(rawResponse, chatHistory);
        continue;
      }

      let respObj;
      try {
        respObj = parseResponse(rawResponse);
      } catch (err) {
        logInvalidResponse(rawResponse, chatHistory);
        continue;
      }
      console.log(respObj);
      const {
        'COMMAND': command,
        'NOTE': newNote,
        'MISSION': newMission,
      } = respObj;
      if (command === undefined) {
        logInvalidResponse(rawResponse, chatHistory);
        continue;
      }
      if (newMission) {
        currentMission = newMission;
        console.log('\x1b[34m%s\x1b[0m', `Mission updated: ${currentMission}`);
      }
      if (newNote) {
        notes.push(newNote);
        console.log('\x1b[36m%s\x1b[0m', `Note: ${newNote}`);
      }

      // add agent's response to the chat history
      chatHistory.push({ role: 'assistant', content: rawResponse });

      // run the command in the game
      // the games response will be added to the chat history elsewhere
      let messages;
      try {
        messages = await zork.input(command);
      } catch (err) {
        logZorkError(err, rawResponse, chatHistory);
        continue;
      }
      const didEnd = messages.join('\n').includes('Your score is ');
      if (didEnd) {
        console.log('\x1b[32m%s\x1b[0m', 'Game ended, restarting...');
        zork = await makeZork(chatHistory);
        printHistory(chatHistory.slice(-1));
        currentMission = initialMission;
        continue;
      }

      // log the last two messages
      printRunState({ currentMission, notes });
      printHistory(chatHistory.slice(-2));

    }
  } catch (err) {
    console.log(err && err.toJSON && err.toJSON() || err)
  }
}

async function makeZork (chatHistory) {
  const zork = await setup();
  zork.events.on('print', (msg) => {
    // Zork spits out a ">" char as a command prompt,
    // which is not needed. We remove it here.
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

async function invokeAgent (model, opts) {
  const { systemPrompt, currentMission, notes, chatHistory, maxHistoryLength = 200 } = opts;
  const systemMessage = systemPrompt
    .replaceAll('{MISSION}', currentMission)
    .replaceAll('{NOTES}', notes.length > 0 ? notes.join('\n') : '(No notes)');
  const ammendedChatHistory = [
    { role: 'system', content: systemMessage },
    ...chatHistory.slice(-maxHistoryLength),
  ]
  const response = await model.invoke(ammendedChatHistory);
  const output = response.content;
  return output;
}

function parseResponse(response) {
  // remove anomalous line endings
  response = response.replaceAll('<br>', '\n')
  response = response.replaceAll('\\\n', '\n')
  const lines = response.split('\n');
  const parsedResponse = {};

  for (let line of lines) {
    const semicolonIndex = line.indexOf(':');
    if (semicolonIndex === -1) continue;
    const key = line.slice(0, semicolonIndex);
    const value = line.slice(semicolonIndex + 1).trim();
    if (Reflect.has(parsedResponse, key)) {
      throw new Error(`Duplicate key in response: ${key}`);
    }
    parsedResponse[key] = value;
  }

  return parsedResponse;
}

function logInvalidResponse (rawResponse, chatHistory) {
  const formattedResponse = JSON.stringify(rawResponse);
  console.info(`>>> Failed to parse response:\n${formattedResponse}`);
  writeDebugLog(chatHistory);
}

function logZorkError (err, rawResponse, chatHistory) {
  console.info(`>>> Zork error: ${err.message}`);
  const formattedResponse = JSON.stringify(rawResponse);
  console.info(`>>> Agent response:\n${formattedResponse}`);
  writeDebugLog(chatHistory);
}

function writeDebugLog (chatHistory) {
  const timestamp = new Date().toISOString()
  const debugLogPath = `./debug-log-${timestamp}.json`
  fs.writeFile(debugLogPath, JSON.stringify(chatHistory, null, 2))
  console.info(`>>> Debug log written to: ${debugLogPath}`)
}

function printHistory (chatHistory) {
  for (const { role, content } of chatHistory) {
    const formattedContent = htmlToTerminal(content)
    if (role === 'user') {
      console.log('\x1b[37m%s\x1b[0m', `Game: ${formattedContent}`)
    } else if (role === 'assistant') {
      console.log('\x1b[35m%s\x1b[0m', `Player: ${formattedContent}`)
    } else {
      console.log(`System: ${formattedContent}`)
    }
  }
}

function printRunState ({ currentMission, notes }) {
  console.log('\x1b[33m%s\x1b[0m', `Mission: ${currentMission}`);
  if (notes.length > 0) {
    console.log('\x1b[33m%s\x1b[0m', `Notes:\n${notes.map(note => `  - ${note}`).join('\n')}`);
  } else {
    console.log('\x1b[33m%s\x1b[0m', 'Notes: (No notes)');
  }
}

function htmlToTerminal(input) {
  // Replace <br> tags with newlines
  let result = input.replace(/<br>/g, '\n');

  // Replace <span class="room"> with bold text formatting
  result = result.replace(/<span class="room">/g, '\x1b[1m');
  // Replace <span class="object"> with underlined text formatting
  result = result.replace(/<span class="object">/g, '\x1b[4m');
  // Replace <span> with no formatting (maintaining the text inside the tag)
  result = result.replace(/<span>/g, '');
  // Replace </span> with reset text formatting
  result = result.replace(/<\/span>/g, '\x1b[0m');

  return result;
}

function isAsciiString(str) {
  // This regular expression matches any character that is not in the ASCII range
  const nonAsciiRegex = /[^\x00-\x7F]/;
  return !nonAsciiRegex.test(str);
}


// Runtime Context Design Notes:
// `Please use this space to maintain your notes and insights during gameplay
// Update this section with relevant information as you progress through the game. You can use the following structure as a guideline and modify it according to your needs:

// - Inventory:
// - Discovered Locations:
// - Turns spent at current location (increment or reset this appropriately): 0
// - Scratch Space:
// - To-Do List:
// - Idea List (categorized):
// - Open Puzzles:
// - General Hints (categorized and prioritized):
//   - Think through your move carefully.
//   - Dont include the location of the item you're interacting with
//   - Only perform a single action per turn.
//   - Avoid providing instructions where the game responds like:
//     - "I don't know the word"
//     - "That sentence isn't one I recognize."
//   - Dont repeat the same action over and over again.
//   - Dont use inexact words like "any"
//   - The "game command" section should be a single extremely simple instruction in all caps trying to perform your intended action, like: "GO NORTH" or "TAKE KNIFE" or "EXAMINE TABLE"
//   - If you get stuck and can't find a solution, try exploring other areas. You may find something that will help you progress.
// - Past Mistakes:`
// )