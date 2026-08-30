import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSystemMessage, trimMessages } from '../src/agent/context.js';
import { ChatMessage, ToolCall } from '../src/llm/types.js';

const call: ToolCall = {
  id: 'call_1',
  type: 'function',
  function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
};

test('trimMessages keeps the system message and recent history', () => {
  const messages: ChatMessage[] = [buildSystemMessage('D:\\work')];
  for (let i = 0; i < 60; i++) {
    messages.push({ role: 'assistant', content: `message ${i}` });
  }

  const trimmed = trimMessages(messages, 10);
  assert.equal(trimmed[0]?.role, 'system');
  assert.equal(trimmed.length, 10);
  assert.match(trimmed[trimmed.length - 1]?.content ?? '', /message 59/);
});

test('trimMessages keeps tool results together with their assistant call', () => {
  const messages: ChatMessage[] = [
    buildSystemMessage('D:\\work'),
    { role: 'user', content: 'task' },
    { role: 'user', content: 'more context' },
    { role: 'assistant', content: null, tool_calls: [call] },
    { role: 'tool', tool_call_id: 'call_1', content: 'result 1' },
    { role: 'tool', tool_call_id: 'call_1', content: 'result 2' },
  ];

  const trimmed = trimMessages(messages, 3);
  assert.equal(trimmed[0]?.role, 'system');
  assert.equal(trimmed[1]?.role, 'assistant');
  assert.equal(trimmed[1]?.tool_calls?.length, 1);
  assert.equal(trimmed[2]?.role, 'tool');
  assert.equal(trimmed[3]?.role, 'tool');
});
