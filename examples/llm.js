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
    // temperature: 0,
    openAIApiKey: OPENAI_API_KEY,
    // vectorStore,
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
  let scratchSpace = '', ideaList = '', responseComprehension = '', hintsList = ''

  await zork.start();

  let template = await fs.readFile('./examples/template.txt', 'utf8');

  const formTemplate = {
    responseComprehension: 'Game Response comprehension',
    hintsList: 'Hints and Tips list',
    scratchSpace: 'Scratch space',
    ideaList: 'Ideas to progress',
    nextAction: 'Next action intention',
    command: 'Game command',
  }

  const formHints = {
    responseComprehension: '[understanding of the games response to your action and explain any problems here]',
    hintsList: '[list general hints and tips for a new player learning how to form commands and explore the game here]',
    scratchSpace: '[you can save some notes here about things you want to remember]',
    ideaList: '[list ideas briefly here]',
    nextAction: '[describe the next action and intention here in plain english]',
    command: '[command here]',
  }

  const promptFormSection = generateStringFromTemplate(formTemplate, formHints);
  template += `Respond in the following format:\n\`\`\`${promptFormSection}\n\`\`\``

  try {
    let rawResponse = ''
    while (true) {
      const recentHistory = history.slice(-36).join('\n============\n')
      const lastMove = history.slice(-1)[0]
      console.log(new Array(4).fill().join(`\n`))
      console.log(`${currentLocation}`)
      console.log(`${lastMove}\n`)
      console.log(`${rawResponse}\n`)

      rawResponse = await rawPrompt(model, {
        template,
        inputVariables: {
          recentHistory,
          currentLocation,
          scratchSpace,
          ideaList,
          hintsList,
        },
      })
      const respObj = parseSectionsFromTemplate(rawResponse, formTemplate)
      // update scratch space and todolist
      scratchSpace = respObj.scratchSpace
      ideaList = respObj.ideaList
      hintsList = respObj.hintsList
      responseComprehension = respObj.responseComprehension
      // add move to history and input it
      history.push(`Player: ${respObj.command}`)
      await zork.input(respObj.command);
    }
  } catch (err) {
    console.log(err && err.toJSON && err.toJSON() || err)
  }
}

function parseSectionsFromTemplate(str, sectionsTemplate) {
  const regexMap = {};

  // Generate regular expressions for each section in the template object
  Object.entries(sectionsTemplate).forEach(([key, value]) => {
    const regex = new RegExp(`${value}:\\s*([\\s\\S]*?)(?:\\n\\n|$)`, 'i');
    regexMap[key] = regex;
  });

  // Use the regular expressions to extract the sections from the input string
  const sections = {};
  Object.entries(regexMap).forEach(([key, regex]) => {
    const match = str.match(regex);
    sections[key] = match ? match[1].trim() : null;
  });

  return sections;
}


function generateStringFromTemplate(sectionsTemplate, values) {
  // Generate an array of strings for each section in the template object
  const sections = [];
  Object.entries(sectionsTemplate).forEach(([key, value]) => {
    const sectionValue = values[key] || '';
    sections.push(`${value}:\n${sectionValue}\n`);
  });

  // Join the section strings together and return the result
  return sections.join('\n');
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