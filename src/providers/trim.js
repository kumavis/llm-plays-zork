// Cache-aware history trimming. Prompt caching is a prefix match, so the
// transcript must only ever grow between requests: the window start stays
// put until the history hits maxMessages, then jumps forward once, keeping
// the most recent keepMessages. Each trim converts tool results at the new
// start of history into plain user text, since the tool calls they answer
// were just trimmed away and both APIs reject orphaned tool results.

const DEFAULT_LIMITS = { maxMessages: 300, keepMessages: 150 };

// Anthropic shape: messages with content-block arrays; tool results are
// `tool_result` blocks inside a user message.
export function trimAnthropicHistory(history, limits = DEFAULT_LIMITS) {
  const { maxMessages, keepMessages } = { ...DEFAULT_LIMITS, ...limits };
  if (history.length <= maxMessages) return history;

  let start = history.length - keepMessages;
  while (start < history.length && history[start].role !== 'user') {
    start += 1;
  }

  const kept = history.slice(start);
  if (kept.length > 0) {
    kept[0] = {
      ...kept[0],
      content: kept[0].content.map((block) =>
        block.type === 'tool_result'
          ? { type: 'text', text: typeof block.content === 'string' ? block.content : '(tool result)' }
          : block,
      ),
    };
  }
  return kept;
}

// OpenAI shape: flat messages; tool results are `role: "tool"` messages
// that must follow the assistant message carrying their tool_calls.
export function trimOpenAIHistory(history, limits = DEFAULT_LIMITS) {
  const { maxMessages, keepMessages } = { ...DEFAULT_LIMITS, ...limits };
  if (history.length <= maxMessages) return history;

  let start = history.length - keepMessages;
  while (start < history.length && history[start].role === 'assistant') {
    start += 1;
  }

  const kept = history.slice(start);
  let leadingToolResults = 0;
  while (leadingToolResults < kept.length && kept[leadingToolResults].role === 'tool') {
    leadingToolResults += 1;
  }
  if (leadingToolResults === 0) return kept;

  const text = kept
    .slice(0, leadingToolResults)
    .map((message) => message.content)
    .join('\n');
  return [{ role: 'user', content: text }, ...kept.slice(leadingToolResults)];
}
