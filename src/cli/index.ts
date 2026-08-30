#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { runAgentTask } from '../agent/loop.js';
import { AppConfig, loadConfig, parseCliArgs } from '../config/config.js';
import { demoSteps, MockProvider, RuleMockProvider } from '../llm/mock.js';
import { OpenAICompatibleProvider } from '../llm/openaiCompatible.js';
import { ChatMessage, ChatProvider } from '../llm/types.js';
import { ApprovalPrompt, AutoApprovePrompt, InteractiveApprovalPrompt } from '../security/approval.js';
import { createSessionId, SessionRecord, SessionStore } from '../session/store.js';
import { ToolRegistry } from '../tools/registry.js';

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  let config: AppConfig;
  try {
    config = await loadConfig(args);
  } catch (err) {
    console.error(`[Forge] 配置错误：${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const provider = createProvider(config, Boolean(args.demo));
  const tools = new ToolRegistry();
  const store = new SessionStore(path.join(config.cwd, config.sessionDir));
  printBanner(config);

  if (args.demo) {
    await runDemo(config, provider, tools, store);
    return;
  }

  if (args.serve) {
    await runServer(config, provider, tools, store, config.port);
    return;
  }

  const rl = createInterface({ input, output, terminal: Boolean(input.isTTY) });
  const approval: ApprovalPrompt = config.autoApprove
    ? new AutoApprovePrompt()
    : new InteractiveApprovalPrompt((question) => rl.question(question));

  let inputClosed = false;
  rl.on('close', () => {
    inputClosed = true;
  });

  const ask = async (): Promise<string | null> => {
    if (inputClosed) {
      return null;
    }
    try {
      return await rl.question('> ');
    } catch {
      return null;
    }
  };

  const session: SessionRecord = {
    id: createSessionId(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cwd: config.cwd,
    provider: provider.name,
    model: provider.model,
    messages: [],
  };

  const loopDeps = {
    provider,
    tools,
    cwd: config.cwd,
    maxRounds: config.maxRounds,
    maxRetries: config.maxRetries,
    commandTimeoutMs: config.commandTimeoutMs,
    approve: (toolName: string, toolArgs: Record<string, unknown>) => approval.approve(toolName, toolArgs),
    onToolCall: (call: { function: { name: string; arguments: string } }) => {
      console.log(`\n[工具] ${call.function.name}(${call.function.arguments})`);
    },
  };

  console.log('输入任务后用回车执行；输入 exit/quit 退出（Ctrl+C 或输入结束也可退出）。\n');

  while (true) {
    const raw = await ask();
    if (raw === null) {
      break;
    }
    const line = raw.trim();
    if (line === 'exit' || line === 'quit') {
      break;
    }
    if (!line) {
      continue;
    }

    const result = await runAgentTask(
      loopDeps,
      line,
      session.messages.length > 0 ? session.messages : undefined,
    );
    if (result.status === 'completed') {
      console.log(`\n${result.answer || '（模型未返回内容）'}`);
    } else {
      console.log(`\n[Forge] ${result.error ?? '任务未完成'}`);
    }

    session.messages = result.messages;
    session.lastAnswer = result.answer;
    session.updatedAt = new Date().toISOString();
    const file = await store.save(session);
    console.log(`(会话已保存: ${file})\n`);
  }

  try {
    rl.close();
  } catch {
    // readline already closed (stdin EOF)
  }
  console.log('再见。');
}

function createProvider(config: AppConfig, demo: boolean): ChatProvider {
  if (config.provider === 'mock') {
    return demo
      ? new MockProvider({ model: config.model, steps: demoSteps() })
      : new RuleMockProvider(config.model);
  }
  return new OpenAICompatibleProvider({
    model: config.model,
    apiKey: config.apiKey as string,
    baseUrl: config.apiBase,
  });
}

async function runDemo(
  config: AppConfig,
  provider: ChatProvider,
  tools: ToolRegistry,
  store: SessionStore,
): Promise<void> {
  const demoDir = path.join(config.cwd, '.forge', 'demo');
  await fs.mkdir(demoDir, { recursive: true });
  const task = '查看当前目录有哪些文件，然后创建一个 hello.txt，内容为 "Hello Forge"，最后列出目录确认';

  console.log(`[演示] 工作目录: ${demoDir}`);
  console.log(`[演示] 任务: ${task}\n`);

  const result = await runAgentTask(
    {
      provider,
      tools,
      cwd: demoDir,
      maxRounds: config.maxRounds,
      maxRetries: config.maxRetries,
      commandTimeoutMs: config.commandTimeoutMs,
      approve: async () => true,
    },
    task,
  );

  console.log('--- 执行记录 ---');
  for (const message of result.messages) {
    if (message.role === 'user') {
      console.log(`用户: ${message.content}`);
    } else if (message.role === 'assistant') {
      if (message.tool_calls && message.tool_calls.length > 0) {
        for (const call of message.tool_calls) {
          console.log(`Agent 调用: ${call.function.name} ${call.function.arguments}`);
        }
      } else {
        console.log(`Agent: ${message.content}`);
      }
    } else if (message.role === 'tool') {
      console.log(`工具结果: ${message.content}`);
    }
  }

  const session: SessionRecord = {
    id: createSessionId(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cwd: demoDir,
    provider: provider.name,
    model: provider.model,
    messages: result.messages,
    lastAnswer: result.answer,
  };
  const file = await store.save(session);

  if (result.status === 'completed') {
    console.log(`\n[演示通过] ${result.answer}`);
  } else {
    console.error(`\n[演示失败] ${result.error ?? '未知错误'}`);
    process.exitCode = 1;
  }
  console.log(`(演示会话已保存: ${file})`);
}

async function runServer(
  config: AppConfig,
  provider: ChatProvider,
  tools: ToolRegistry,
  store: SessionStore,
  port: number,
): Promise<void> {
  if (!config.autoApprove) {
    console.log('提示: 服务模式下写文件与执行命令将自动批准（无交互审批通道）。');
  }
  const conversation: ChatMessage[] = [];
  const server = http.createServer((req, res) => {
    handleHttpRequest(req, res, config, provider, tools, store, conversation).catch((err) => {
      console.error(`[Forge] 请求处理出错: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      try {
        res.end(JSON.stringify({ error: 'internal error' }));
      } catch {
        // ignore
      }
    });
  });
  server.on('error', (err) => {
    console.error(`[Forge] 服务启动失败: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  if (server.listening) {
    console.log(`[Forge] 实时交互服务已启动: http://localhost:${port}`);
    console.log('[Forge] 在浏览器打开上述地址即可开始对话；按 Ctrl+C 退出。');
    console.log(`[Forge] 工作目录: ${config.cwd}\n`);
  }
}

async function handleHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AppConfig,
  provider: ChatProvider,
  tools: ToolRegistry,
  store: SessionStore,
  conversation: ChatMessage[],
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    serveChatPage(res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/clear') {
    conversation.length = 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/task') {
    await serveTask(req, res, config, provider, tools, store, conversation);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}

function serveChatPage(res: http.ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(CHAT_PAGE_HTML);
}

async function serveTask(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AppConfig,
  provider: ChatProvider,
  tools: ToolRegistry,
  store: SessionStore,
  conversation: ChatMessage[],
): Promise<void> {
  let body = '';
  for await (const chunk of req) {
    body += chunk.toString();
  }
  let taskInput = '';
  try {
    const parsed = JSON.parse(body || '{}') as { input?: unknown };
    taskInput = typeof parsed.input === 'string' ? parsed.input.trim() : '';
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
    res.end(JSON.stringify({ type: 'error', error: '请求体需为 JSON: {"input":"..."}' }) + '\n');
    return;
  }
  if (!taskInput) {
    res.writeHead(400, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
    res.end(JSON.stringify({ type: 'error', error: 'input 为空' }) + '\n');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });

  const writeEvent = (obj: unknown): void => {
    res.write(JSON.stringify(obj) + '\n');
  };

  const session: SessionRecord = {
    id: createSessionId(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cwd: config.cwd,
    provider: provider.name,
    model: provider.model,
    messages: [],
  };

  writeEvent({ type: 'start', sessionId: session.id, cwd: config.cwd, model: provider.model });
  console.log(`[服务] 任务 ${session.id}: ${taskInput}`);

  try {
    const result = await runAgentTask(
      {
        provider,
        tools,
        cwd: config.cwd,
        maxRounds: config.maxRounds,
        maxRetries: config.maxRetries,
        commandTimeoutMs: config.commandTimeoutMs,
        approve: async () => true,
        onAssistantMessage: (message) =>
          writeEvent({
            type: 'assistant',
            content: message.content,
            toolCalls: (message.tool_calls ?? []).map((call) => ({
              name: call.function.name,
              arguments: call.function.arguments,
            })),
          }),
        onToolCall: (call) =>
          writeEvent({ type: 'tool_call', name: call.function.name, arguments: call.function.arguments }),
        onToolResult: (call, toolResult) =>
          writeEvent({
            type: 'tool_result',
            name: call.function.name,
            ok: toolResult.ok,
            output: toolResult.output,
            error: toolResult.error,
          }),
      },
      taskInput,
      conversation.length > 0 ? conversation : undefined,
    );

    conversation.length = 0;
    conversation.push(...result.messages);
    session.messages = result.messages;
    session.lastAnswer = result.answer;
    session.updatedAt = new Date().toISOString();
    const file = await store.save(session);
    writeEvent({
      type: 'done',
      status: result.status,
      answer: result.answer,
      rounds: result.rounds,
      error: result.error,
      sessionFile: file,
    });
  } catch (err) {
    writeEvent({ type: 'error', error: err instanceof Error ? err.message : String(err) });
  } finally {
    res.end();
  }
}

const CHAT_PAGE_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Forge 实时交互</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; max-width: 900px; margin: 0 auto; padding: 16px; }
  header { display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px; }
  h1 { font-size: 1.1rem; margin: 0; }
  header .sub { font-size: 0.75rem; opacity: 0.6; }
  #log { border: 1px solid rgba(127,127,127,0.34); border-radius: 10px; padding: 10px; height: 58vh; overflow-y: auto; background: rgba(127,127,127,0.06); }
  .ev { margin: 6px 0; padding: 7px 10px; border-radius: 8px; font-size: 0.92rem; white-space: pre-wrap; word-break: break-word; }
  .ev.assistant { background: rgba(80,110,255,0.14); }
  .ev.tool { background: rgba(60,160,80,0.14); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.84rem; }
  .ev.result { background: rgba(220,150,40,0.14); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.84rem; }
  .ev.done { background: rgba(180,150,60,0.18); font-weight: 600; }
  .ev.error { background: rgba(220,40,40,0.16); color: #b22; }
  .tag { font-size: 0.68rem; opacity: 0.55; margin-right: 6px; text-transform: uppercase; letter-spacing: 0.05em; }
  .row { display: flex; gap: 8px; margin-top: 10px; }
  textarea { flex: 1; resize: vertical; font: inherit; }
  button { padding: 8px 18px; font: inherit; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
</style>
</head>
<body>
<header>
  <h1>Forge 实时交互</h1>
  <span class="sub" id="status">就绪</span>
</header>
<div id="log"></div>
<div class="row">
  <textarea id="input" rows="2" placeholder="输入任务，回车发送（Shift+回车换行）"></textarea>
  <button id="send">发送</button>
  <button id="clearBtn" type="button">清空</button>
</div>
<script>
var log = document.getElementById('log');
var inputEl = document.getElementById('input');
var sendBtn = document.getElementById('send');
var clearBtn = document.getElementById('clearBtn');
var statusEl = document.getElementById('status');

function add(type, html) {
  var div = document.createElement('div');
  div.className = 'ev ' + type;
  div.innerHTML = html;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
  });
}

function render(ev) {
  switch (ev.type) {
    case 'start':
      add('tool', '<span class="tag">开始</span>模型 ' + esc(ev.model) + ' · 工作目录 ' + esc(ev.cwd));
      break;
    case 'assistant':
      if (ev.content) add('assistant', '<span class="tag">Agent</span>' + esc(ev.content));
      if (ev.toolCalls && ev.toolCalls.length) {
        ev.toolCalls.forEach(function (c) {
          add('tool', '<span class="tag">调用</span>' + esc(c.name) + '(' + esc(c.arguments) + ')');
        });
      }
      break;
    case 'tool_call':
      add('tool', '<span class="tag">调用</span>' + esc(ev.name) + '(' + esc(ev.arguments) + ')');
      break;
    case 'tool_result':
      add('result', '<span class="tag">' + (ev.ok ? '结果' : '失败') + '</span>' + esc(ev.output || ev.error || ''));
      break;
    case 'done':
      add('done', '<span class="tag">完成</span>' + esc(ev.answer || ev.error || '') + (ev.rounds ? ' · 轮次 ' + ev.rounds : ''));
      break;
    case 'error':
      add('error', '<span class="tag">错误</span>' + esc(ev.error));
      break;
  }
}

async function runTask() {
  var text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = '';
  sendBtn.disabled = true;
  statusEl.textContent = '运行中…';
  add('assistant', '<span class="tag">你</span>' + esc(text));
  try {
    var resp = await fetch('/api/task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text })
    });
    var reader = resp.body.getReader();
    var decoder = new TextDecoder();
    var buf = '';
    while (true) {
      var out = await reader.read();
      if (out.done) break;
      buf += decoder.decode(out.value, { stream: true });
      var nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        var line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try { render(JSON.parse(line)); } catch (e) {}
      }
    }
  } catch (e) {
    add('error', '<span class="tag">错误</span>' + esc(e.message || String(e)));
  } finally {
    sendBtn.disabled = false;
    statusEl.textContent = '就绪';
    inputEl.focus();
  }
}

inputEl.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runTask(); }
});
sendBtn.addEventListener('click', runTask);
clearBtn.addEventListener('click', async function () {
  try { await fetch('/api/clear', { method: 'POST' }); } catch (e) {}
  log.innerHTML = '';
  statusEl.textContent = '已清空';
  inputEl.focus();
});
inputEl.focus();
</script>
</body>
</html>`;

function printBanner(config: AppConfig): void {
  console.log('Forge v0.1.0 (M1 MVP)');
  console.log(`Provider: ${config.provider}`);
  console.log(`Model: ${config.model}`);
  console.log(`工作目录: ${config.cwd}`);
  if (config.provider === 'mock') {
    console.log('提示: 当前为 Mock 离线模式（未检测到有效 API 配置或显式指定）。');
  }
  if (config.autoApprove) {
    console.log('警告: 已开启自动审批，写文件与执行命令不再逐项询问。');
  }
  console.log('');
}

function printHelp(): void {
  console.log(`用法: node dist/src/cli/index.js [选项]

选项:
  --provider <mock|openai-compatible>  模型 Provider（默认自动选择）
  --model <name>                       模型名
  --api-base <url>                     OpenAI 兼容 API 地址
  --cwd <path>                         工作目录
  --max-rounds <n>                     最大工具轮次（默认 12）
  --max-retries <n>                    模型调用最大重试次数（默认 2）
  --command-timeout-ms <n>             命令超时毫秒数（默认 30000）
  --auto-approve                       自动批准写文件/执行命令（演示或测试用）
  --serve                              启动 HTTP 实时交互服务（浏览器可对话）
  --port <n>                           服务端口（默认 8787，可用 FORGE_PORT）
  --demo                               运行离线验收演示后退出
  --help                               显示帮助

环境变量:
  FORGE_API_KEY, FORGE_API_BASE, FORGE_MODEL, FORGE_CWD, FORGE_PORT,
  FORGE_MAX_ROUNDS, FORGE_MAX_RETRIES, FORGE_COMMAND_TIMEOUT_MS, FORGE_AUTO_APPROVE

示例:
  node dist/src/cli/index.js --demo
  node dist/src/cli/index.js --serve --port 8787
  node dist/src/cli/index.js --cwd D:/workspace
  $env:FORGE_API_KEY='sk-...'; node dist/src/cli/index.js --provider openai-compatible
`);
}

await main();
