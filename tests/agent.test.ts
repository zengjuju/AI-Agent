import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { runAgentTask } from '../src/agent/loop.js';
import { demoSteps, MockProvider, textResponse, toolCallResponse } from '../src/llm/mock.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => removeTempDir(dir)));
});

async function tempCwd(): Promise<string> {
  const dir = await makeTempDir();
  tempDirs.push(dir);
  return dir;
}

test('runs the M1 acceptance scenario with a scripted mock', async () => {
  const cwd = await tempCwd();
  const provider = new MockProvider({ model: 'forge-mock', steps: demoSteps() });
  const tools = new ToolRegistry();
  const executed: string[] = [];

  const result = await runAgentTask(
    {
      provider,
      tools,
      cwd,
      approve: async () => true,
      onToolCall: (call) => executed.push(call.function.name),
    },
    '查看当前目录有哪些文件，然后创建一个 hello.txt，内容为 "Hello Forge"，最后列出目录确认',
  );

  assert.equal(result.status, 'completed');
  assert.deepEqual(executed, ['list_dir', 'write_file', 'list_dir']);
  assert.match(result.answer ?? '', /演示完成/);

  const content = await fs.readFile(path.join(cwd, 'hello.txt'), 'utf8');
  assert.equal(content, 'Hello Forge');
});

test('stops at max rounds when the model keeps calling tools', async () => {
  const cwd = await tempCwd();
  const provider = new MockProvider({
    model: 'forge-mock',
    steps: [
      () => toolCallResponse('list_dir', { path: '.' }),
      () => toolCallResponse('list_dir', { path: '.' }),
    ],
  });
  const tools = new ToolRegistry();

  const result = await runAgentTask(
    { provider, tools, cwd, approve: async () => true, maxRounds: 2 },
    '不断调用工具',
  );

  assert.equal(result.status, 'max_rounds');
  assert.match(result.error ?? '', /最大工具轮次/);
});

test('feeds tool errors back so the model can recover', async () => {
  const cwd = await tempCwd();
  const provider = new MockProvider({
    model: 'forge-mock',
    steps: [
      () => toolCallResponse('read_file', { path: 'missing.txt' }),
      (messages) => {
        const last = messages[messages.length - 1];
        assert.equal(last?.role, 'tool');
        assert.match(last?.content ?? '', /ERROR/);
        return textResponse('文件不存在，任务结束。');
      },
    ],
  });
  const tools = new ToolRegistry();

  const result = await runAgentTask({ provider, tools, cwd, approve: async () => true }, '读取 missing.txt');
  assert.equal(result.status, 'completed');
  assert.match(result.answer ?? '', /不存在/);
});
