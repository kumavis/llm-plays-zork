function parseResponse(response) {
  const lines = response.split('\n');
  const parsedResponse = {};
  let currentKey = '';

  for (let line of lines) {
    const keyValueMatch = line.match(/^\*\*(.+?):\*\*$/);

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

// Example usage:
const response = `
**Result of the last attempted action:**
The game responded with "I beg your pardon?" as the previous command was undefined.

**Updated Player's Note Space:**
Undefined

**Intention of the next action:**
To explore the location and search for any useful items or clues.

**Command to perform the next action:**
LOOK
`;

const parsed = parseResponse(response);
console.log(parsed);
