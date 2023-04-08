import * as fs from 'fs/promises';
import { LLMChain } from "langchain/chains";
import { PromptTemplate } from "langchain/prompts";
import { ChatOpenAI } from "langchain/chat_models";
import dotenv from "dotenv";
import { setup } from "../index.js";

dotenv.config();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

main()

async function main () {
  const model = new ChatOpenAI({
    openAIApiKey: OPENAI_API_KEY,
  }, {
    // basePath: "https://oai.hconeai.com/v1",
  });

  const zork = await setup()
  const history = []
  zork.events.on('print', (msg) => {
    history.push(`Game: ${msg}`)
  });
  let currentLocation = ''
  zork.events.on('header', (msg) => {
    // console.log(`header: ${msg}`)
    currentLocation = msg
  });
  let scratchSpace = (
  `Please use this space to maintain your notes and insights during gameplay
  Update this section with relevant information as you progress through the game. You can use the following structure as a guideline and modify it according to your needs:
  
  - Inventory
  - Discovered Locations
  - Non-Player Characters (NPCs)
  - Scratch Space
  - To-Do List
  - Idea List (categorized)
  - Open Puzzles
  - General Hints (categorized and prioritized)
  - Past Mistakes`
  )

  await zork.start();

  let template = await fs.readFile('./examples/template.txt', 'utf8');

  try {
    let rawResponse = ''
    while (true) {
      const recentHistory = history.slice(-36).join('\n============\n')

      rawResponse = await rawPrompt(model, {
        template,
        inputVariables: {
          recentHistory,
          currentLocation,
          scratchSpace,
          // ideaList,
          // hintsList,
        },
      })

      // const respObj = parseSectionsFromTemplate(rawResponse, formTemplate)
      const respObj = parseResponse(rawResponse)
      const {
        // 'Result of the last attempted action': _responseComprehension,
        'Updated Player\'s Note Space': _scratchSpace,
        // 'Intention of the next action': _intention,
        'Command to perform the next action': _command,
      } = respObj

      // update scratch space and todolist
      if (_scratchSpace !== undefined) {
        scratchSpace = _scratchSpace
      }
      // responseComprehension = _responseComprehension
      // add move to history and input it
      history.push(`Player: ${_command}`)
      await zork.input(_command);

      // log move and result
      const lastMove = history.slice(-1)[0]
      console.log(new Array(4).fill().join(`\n`))
      console.log(`${rawResponse}\n`)
      console.dir(respObj)
      console.log(`${currentLocation}`)
      console.log(`${htmlToTerminal(lastMove)}\n`)

    }
  } catch (err) {
    console.log(err && err.toJSON && err.toJSON() || err)
  }
}

function parseResponse(response) {
  const lines = response.split('\n');
  const parsedResponse = {};
  let currentKey = '';

  for (let line of lines) {
    const keyValueMatch = line.match(/^\*\*(.+?):\*\*\s*$/);

    if (keyValueMatch) {
      currentKey = keyValueMatch[1].trim();
      parsedResponse[currentKey] = '';
    } else {
      if (currentKey) {
        parsedResponse[currentKey] += line.trim() + '\n';
      }
    }
  }

  // Trim trailing newlines from values
  for (let key in parsedResponse) {
    parsedResponse[key] = parsedResponse[key].trim();
  }

  return parsedResponse;
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

async function rawPrompt (model, opts) {
  const prompt = new PromptTemplate({
    template: opts.template,
    inputVariables: Object.keys(opts.inputVariables),
  })
  const chain = new LLMChain({
    prompt: prompt,
    llm: model,
  });
  // console.dir(opts);
  let response = await chain.call(opts.inputVariables);
  // console.log('response', response);
  // console.dir({ response })
  return response.text;
}