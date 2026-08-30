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
import { createSessionId, SessionMeta, SessionStore } from '../session/store.js';
import { FactStore } from '../memory/factStore.js';
import { buildMemoryTool } from '../tools/memory.js';
import { ToolRegistry } from '../tools/registry.js';
import { compactContext, estimateTotalTokens } from '../agent/context.js';

/* ================================================================
 * 主入口
 * ================================================================ */
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

  // 长期记忆（用户偏好）—— 所有入口共享
  const factStore = new FactStore(config.cwd);
  tools.register(buildMemoryTool(factStore));

  // 会话存储（事件日志 + 元信息）
  const store = new SessionStore(config.cwd);
  printBanner(config);

  if (args.demo) {
    await runDemo(config, provider, tools, store, factStore);
    return;
  }

  if (args.serve) {
    await runServer(config, provider, tools, store, factStore, config.port);
    return;
  }

  // 终端 REPL
  const rl = createInterface({ input, output, terminal: Boolean(input.isTTY) });
  const approval: ApprovalPrompt = config.autoApprove
    ? new AutoApprovePrompt()
    : new InteractiveApprovalPrompt((question) => rl.question(question));

  let inputClosed = false;
  rl.on('close', () => {
    inputClosed = true;
  });

  const ask = async (): Promise<string | null> => {
    if (inputClosed) return null;
    try {
      return await rl.question('> ');
    } catch {
      return null;
    }
  };

  // 会话 id（REPL 整次生命周期一个）
  const sessionId = createSessionId();
  store.eventLog.open(sessionId);
  store.eventLog.append('session_start', { cwd: config.cwd, provider: provider.name, model: provider.model });
  const meta: SessionMeta = {
    id: sessionId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cwd: config.cwd,
    provider: provider.name,
    model: provider.model,
    eventCount: 1,
  };
  store.saveMeta(meta);
  let historyMsgs: ChatMessage[] = [];

  const loopDeps = () => ({
    provider,
    tools,
    cwd: config.cwd,
    maxRounds: config.maxRounds,
    maxRetries: config.maxRetries,
    commandTimeoutMs: config.commandTimeoutMs,
    longTermFacts: factStore.formatForPrompt(),
    approve: (toolName: string, toolArgs: Record<string, unknown>) => approval.approve(toolName, toolArgs),
    onToolCall: (call: { function: { name: string; arguments: string } }) => {
      console.log(`\n[工具] ${call.function.name}(${call.function.arguments})`);
    },
  });

  console.log('输入任务后用回车执行；输入 exit/quit 退出（Ctrl+C 或输入结束也可退出）。\n');

  while (true) {
    const raw = await ask();
    if (raw === null) break;
    const line = raw.trim();
    if (line === 'exit' || line === 'quit') break;
    if (!line) continue;

    store.eventLog.append('user_message', { content: line });

    const result = await runAgentTask(loopDeps(), line, historyMsgs.length > 0 ? historyMsgs : undefined);

    // 写入 assistant + tool 事件
    const prevLen = historyMsgs.length;
    for (const m of result.messages.slice(prevLen + 1)) {
      if (m.role === 'assistant') {
        store.eventLog.append('assistant_message', {
          content: m.content ?? '',
          tool_calls: (m.tool_calls ?? []).map((tc) => ({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments })),
        });
      } else if (m.role === 'tool') {
        store.eventLog.append('tool_result', {
          tool_call_id: m.tool_call_id,
          output: m.content,
        });
      }
    }

    if (result.status === 'completed') {
      console.log(`\n${result.answer || '（模型未返回内容）'}`);
    } else {
      console.log(`\n[Forge] ${result.error ?? '任务未完成'}`);
    }

    historyMsgs = result.messages;
    meta.lastAnswer = result.answer;
    meta.updatedAt = new Date().toISOString();
    meta.eventCount = store.eventLog.listSessionFiles().find((s) => s.sessionId === sessionId)?.eventCount ?? 0;
    store.saveMeta(meta);
  }

  try { rl.close(); } catch { /* ignore */ }
  store.eventLog.append('session_end', {});
  store.eventLog.close();
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

/* ================================================================
 * 演示模式
 * ================================================================ */
async function runDemo(
  config: AppConfig,
  provider: ChatProvider,
  tools: ToolRegistry,
  store: SessionStore,
  factStore: FactStore,
): Promise<void> {
  const demoDir = path.join(config.cwd, '.forge', 'demo');
  await fs.mkdir(demoDir, { recursive: true });
  const task = '查看当前目录有哪些文件，然后创建一个 hello.txt，内容为 "Hello Forge"，最后列出目录确认';

  console.log(`[演示] 工作目录: ${demoDir}`);
  console.log(`[演示] 任务: ${task}\n`);

  const sessionId = createSessionId();
  store.eventLog.open(sessionId);
  store.eventLog.append('session_start', { cwd: demoDir, provider: provider.name, model: provider.model });

  const result = await runAgentTask(
    {
      provider,
      tools,
      cwd: demoDir,
      maxRounds: config.maxRounds,
      maxRetries: config.maxRetries,
      commandTimeoutMs: config.commandTimeoutMs,
      longTermFacts: factStore.formatForPrompt(),
      approve: async () => true,
    },
    task,
  );

  // 回放写日志
  for (const m of result.messages) {
    if (m.role === 'user') store.eventLog.append('user_message', { content: m.content });
    else if (m.role === 'assistant')
      store.eventLog.append('assistant_message', {
        content: m.content ?? '',
        tool_calls: (m.tool_calls ?? []).map((tc) => ({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments })),
      });
    else if (m.role === 'tool')
      store.eventLog.append('tool_result', { tool_call_id: m.tool_call_id, output: m.content });
  }
  store.eventLog.append('session_end', {});
  store.eventLog.close();

  store.saveMeta({
    id: sessionId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cwd: demoDir,
    provider: provider.name,
    model: provider.model,
    lastAnswer: result.answer,
    eventCount: 0,
  });

  console.log('--- 执行记录 ---');
  for (const message of result.messages) {
    if (message.role === 'user') console.log(`用户: ${message.content}`);
    else if (message.role === 'assistant') {
      if (message.tool_calls && message.tool_calls.length > 0) {
        for (const call of message.tool_calls) {
          console.log(`Agent 调用: ${call.function.name} ${call.function.arguments}`);
        }
      } else console.log(`Agent: ${message.content}`);
    } else if (message.role === 'tool') console.log(`工具结果: ${message.content}`);
  }

  if (result.status === 'completed') console.log(`\n[演示通过] ${result.answer}`);
  else {
    console.error(`\n[演示失败] ${result.error ?? '未知错误'}`);
    process.exitCode = 1;
  }
}

/* ================================================================
 * HTTP 服务 + 路由（改进点 3）
 * ================================================================ */

/** 当前活动会话状态（服务端） */
interface ActiveSession {
  id: string;
  history: ChatMessage[];   // 累积消息
  meta: SessionMeta;
}

async function runServer(
  config: AppConfig,
  provider: ChatProvider,
  tools: ToolRegistry,
  store: SessionStore,
  factStore: FactStore,
  port: number,
): Promise<void> {
  if (!config.autoApprove) {
    console.log('提示: 服务模式下写文件与执行命令将自动批准（无交互审批通道）。');
  }

  // 当前活跃会话（切换 resume 时会变）
  let active: ActiveSession | null = null;

  const server = http.createServer((req, res) => {
    handleHttpRequest(req, res, config, provider, tools, store, factStore, {
      get: () => active,
      set: (next) => { active = next; },
    }).catch((err) => {
      console.error(`[Forge] 请求处理出错: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      try { res.end(JSON.stringify({ error: 'internal error' })); } catch { /* ignore */ }
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
    console.log(`[Forge] 工作目录: ${config.cwd}`);
    console.log(`[Forge] 长期偏好事实: ${factStore.list().length} 条`);
  }
}

type ActiveRef = { get: () => ActiveSession | null; set: (s: ActiveSession | null) => void; };

async function handleHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AppConfig,
  provider: ChatProvider,
  tools: ToolRegistry,
  store: SessionStore,
  factStore: FactStore,
  active: ActiveRef,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';

  // 静态页
  if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    serveChatPage(res);
    return;
  }

  // 记忆管理 API
  if (method === 'GET' && url.pathname === '/api/memory') {
    jsonRes(res, 200, { facts: factStore.list() });
    return;
  }
  if (method === 'POST' && url.pathname === '/api/memory') {
    const body = await readJsonBody<{ fact?: string }>(req);
    const f = String(body.fact ?? '').trim();
    if (!f) { jsonRes(res, 400, { error: 'fact 不能为空' }); return; }
    const saved = factStore.add(f, 'preference');
    jsonRes(res, 200, { ok: true, fact: saved });
    return;
  }
  if (method === 'DELETE' && url.pathname === '/api/memory') {
    const body = await readJsonBody<{ id?: number }>(req);
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) { jsonRes(res, 400, { error: 'id 必须是正整数' }); return; }
    const ok = factStore.delete(id);
    jsonRes(res, 200, { ok });
    return;
  }

  // 会话管理 API
  if (method === 'GET' && url.pathname === '/api/sessions') {
    jsonRes(res, 200, {
      sessions: store.list(),
      currentId: active.get()?.id ?? null,
    });
    return;
  }
  if (method === 'POST' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/resume')) {
    const id = url.pathname.slice('/api/sessions/'.length, -'/resume'.length);
    const history = store.replayMessages(id);
    const meta = store.loadMeta(id) ?? {
      id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      cwd: config.cwd, provider: provider.name, model: provider.model, eventCount: 0,
    };
    active.set({ id, history, meta });
    jsonRes(res, 200, { ok: true, id, messageCount: history.length, summary: store.autoSummary(id) });
    return;
  }
  if (method === 'POST' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/fork')) {
    const id = url.pathname.slice('/api/sessions/'.length, -'/fork'.length);
    const newId = createSessionId();
    const result = store.fork(id, newId);
    if (!result) { jsonRes(res, 404, { error: 'session not found' }); return; }
    jsonRes(res, 200, { ok: true, newId, meta: result });
    return;
  }
  if (method === 'DELETE' && url.pathname.startsWith('/api/sessions/')) {
    const id = url.pathname.slice('/api/sessions/'.length);
    const ok = store.delete(id);
    if (active.get()?.id === id) active.set(null);
    jsonRes(res, 200, { ok });
    return;
  }

  // 手动 CHECKPOINT 压缩
  if (method === 'POST' && url.pathname === '/api/compact') {
    const a = active.get();
    if (!a || a.history.length === 0) { jsonRes(res, 200, { ok: false, reason: 'no active history' }); return; }
    const result = await compactContext(a.history, provider, provider.name.startsWith('mock') ? 16_000 : 128_000);
    a.history = result.messages;
    // 写 checkpoint 事件
    store.eventLog.open(a.id);
    if (result.summary) store.eventLog.append('checkpoint', { summary: result.summary, savedTokens: result.tokenStats.saved });
    a.meta.updatedAt = new Date().toISOString();
    store.saveMeta(a.meta);
    jsonRes(res, 200, { ok: true, ...result.tokenStats, didCompact: result.didCompact, summary: result.summary });
    return;
  }

  // 清空当前会话
  if (method === 'POST' && url.pathname === '/api/clear') {
    active.set(null);
    jsonRes(res, 200, { ok: true });
    return;
  }

  // 任务处理（流式 NDJSON）
  if (method === 'POST' && url.pathname === '/api/task') {
    await serveTask(req, res, config, provider, tools, store, factStore, active);
    return;
  }

  jsonRes(res, 404, { error: 'not found' });
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  let body = '';
  for await (const chunk of req) body += chunk.toString();
  try {
    return (body ? JSON.parse(body) : {}) as T;
  } catch {
    return {} as T;
  }
}

function jsonRes(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/* ================================================================
 * 任务流式处理 + 事件日志写入
 * ================================================================ */
async function serveTask(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AppConfig,
  provider: ChatProvider,
  tools: ToolRegistry,
  store: SessionStore,
  factStore: FactStore,
  active: ActiveRef,
): Promise<void> {
  let body = '';
  for await (const chunk of req) body += chunk.toString();
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
  const writeEvent = (obj: unknown): void => { res.write(JSON.stringify(obj) + '\n'); };

  // 新会话？还是续接旧的？
  let now = active.get();
  if (!now) {
    const id = createSessionId();
    now = {
      id,
      history: [],
      meta: {
        id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        cwd: config.cwd,
        provider: provider.name,
        model: provider.model,
        eventCount: 0,
      },
    };
    active.set(now);
    store.eventLog.open(id);
    store.eventLog.append('session_start', { cwd: config.cwd, provider: provider.name, model: provider.model });
  } else {
    store.eventLog.open(now.id);
  }

  const taskStartMs = Date.now();
  writeEvent({ type: 'start', sessionId: now.id, cwd: config.cwd, model: provider.model });
  console.log(`[服务] 会话 ${now.id}: ${taskInput}`);

  // 写 user_message 事件
  store.eventLog.append('user_message', { content: taskInput });

  try {
    const result = await runAgentTask(
      {
        provider,
        tools,
        cwd: config.cwd,
        maxRounds: config.maxRounds,
        maxRetries: config.maxRetries,
        commandTimeoutMs: config.commandTimeoutMs,
        longTermFacts: factStore.formatForPrompt(),
        approve: async () => true,
        onAssistantMessage: (message) => {
          writeEvent({
            type: 'assistant',
            content: message.content,
            toolCalls: (message.tool_calls ?? []).map((call) => ({
              name: call.function.name,
              arguments: call.function.arguments,
            })),
          });
        },
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
        onCompact: (info) => {
          writeEvent({ type: 'compact', ...info });
          if (info.summary) store.eventLog.append('checkpoint', { summary: info.summary, savedTokens: info.savedTokens });
        },
      },
      taskInput,
      now.history.length > 0 ? now.history : undefined,
    );

    // 把 assistant + tool 结果写进事件日志
    for (const m of result.messages) {
      if (m.role === 'assistant') {
        store.eventLog.append('assistant_message', {
          content: m.content ?? '',
          tool_calls: (m.tool_calls ?? []).map((tc) => ({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments })),
        });
      } else if (m.role === 'tool') {
        store.eventLog.append('tool_result', { tool_call_id: m.tool_call_id, output: m.content });
      }
    }

    // 更新活跃会话的累积历史
    now.history.length = 0;
    now.history.push(...result.messages);
    now.meta.lastAnswer = result.answer;
    now.meta.updatedAt = new Date().toISOString();
    now.meta.eventCount = (now.meta.eventCount ?? 0) + 10; // 近似值
    store.saveMeta(now.meta);

    const elapsedMs = Date.now() - taskStartMs;
    writeEvent({
      type: 'done',
      status: result.status,
      answer: result.answer,
      rounds: result.rounds,
      error: result.error,
      elapsedMs,
      tokenEstimate: estimateTotalTokens(result.messages),
    });
  } catch (err) {
    writeEvent({ type: 'error', error: err instanceof Error ? err.message : String(err) });
  } finally {
    res.end();
  }
}

/* ================================================================
 * 前端页面（改进点 4：左侧抽屉 + 新 UI）
 * ================================================================ */
function serveChatPage(res: http.ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(CHAT_PAGE_HTML);
}

const CHAT_PAGE_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Forge</title>
<style>
:root {
  --bg: #ffffff;
  --bg-elev: #f7f7f8;
  --bg-hover: #f0f0f2;
  --bg-sidebar: #fafafb;
  --border: #e5e5e8;
  --text: #1a1a1f;
  --text-dim: #6b6b74;
  --text-mute: #9a9aa3;
  --accent: #4f6ef7;
  --accent-hover: #3d5be0;
  --accent-soft: rgba(79,110,247,0.10);
  --success: #16a34a;
  --warn: #d97706;
  --error: #dc2626;
  --user-bubble: #4f6ef7;
  --user-bubble-text: #ffffff;
  --assistant-bubble: #f2f2f4;
  --assistant-bubble-text: #1a1a1f;
  --shadow: 0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
  --shadow-lg: 0 8px 24px rgba(0,0,0,0.08);
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f0f12;
    --bg-elev: #17171c;
    --bg-hover: #1f1f25;
    --bg-sidebar: #0b0b0e;
    --border: #2a2a31;
    --text: #ededf0;
    --text-dim: #9a9aa3;
    --text-mute: #6b6b74;
    --accent: #6d85ff;
    --accent-hover: #5a75f0;
    --accent-soft: rgba(109,133,255,0.14);
    --success: #22c55e;
    --warn: #f59e0b;
    --error: #ef4444;
    --user-bubble: #6d85ff;
    --user-bubble-text: #0f0f12;
    --assistant-bubble: #1f1f25;
    --assistant-bubble-text: #ededf0;
    --shadow: 0 1px 3px rgba(0,0,0,0.3);
    --shadow-lg: 0 8px 24px rgba(0,0,0,0.4);
  }
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", Roboto, sans-serif;
  background: var(--bg);
  color: var(--text);
  display: flex;
  overflow: hidden;
}

/* === Sidebar === */
.sidebar {
  width: 280px; flex-shrink: 0;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border);
  display: flex; flex-direction: column;
  transition: transform 0.25s ease;
  z-index: 30;
}
.sidebar-header {
  height: 52px;
  border-bottom: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 14px;
}
.sidebar-brand {
  display: flex; align-items: center; gap: 8px;
}
.sidebar-brand .logo {
  width: 26px; height: 26px; border-radius: 7px;
  background: linear-gradient(135deg, var(--accent), #9b5bff);
  color: #fff; font-weight: 700; font-size: 13px;
  display: grid; place-items: center;
}
.sidebar-brand .name { font-size: 14px; font-weight: 600; }
.sidebar-actions { display: flex; gap: 4px; }
.icon-btn {
  width: 28px; height: 28px; border-radius: 7px;
  background: transparent; border: none; color: var(--text-dim);
  display: grid; place-items: center; cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.icon-btn:hover { background: var(--bg-hover); color: var(--text); }

.sidebar-section-label {
  font-size: 11px; color: var(--text-mute);
  padding: 16px 14px 6px; text-transform: uppercase; letter-spacing: 0.6px;
  display: flex; align-items: center; justify-content: space-between;
}
.sidebar-list {
  flex: 1; overflow-y: auto;
  padding: 0 8px;
}
.session-item {
  padding: 10px 10px;
  border-radius: var(--radius-md);
  cursor: pointer;
  margin-bottom: 2px;
  display: flex; align-items: flex-start; gap: 10px;
  transition: background 0.12s;
  position: relative;
}
.session-item:hover { background: var(--bg-hover); }
.session-item.active { background: var(--accent-soft); }
.session-item-icon {
  width: 22px; height: 22px; flex-shrink: 0; border-radius: 5px;
  background: var(--bg-hover); display: grid; place-items: center;
  font-size: 12px; color: var(--text-dim);
}
.session-item.active .session-item-icon { background: #fff; color: var(--accent); }
.session-item-body { flex: 1; min-width: 0; }
.session-item-title {
  font-size: 13px; color: var(--text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  margin-bottom: 3px;
}
.session-item-meta {
  font-size: 11px; color: var(--text-mute);
}
.session-item-actions {
  display: none; gap: 2px;
  position: absolute; right: 6px; top: 6px;
  background: var(--bg-sidebar);
  border: 1px solid var(--border); border-radius: 6px; padding: 2px;
}
.session-item:hover .session-item-actions { display: flex; }

/* Memory panel */
.memory-list { padding: 0 10px 10px; display: flex; flex-direction: column; gap: 6px; max-height: 300px; overflow-y: auto; }
.memory-item {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 8px 10px; background: var(--bg);
  border: 1px solid var(--border); border-radius: var(--radius-md);
}
.memory-item-text {
  flex: 1; font-size: 12.5px; line-height: 1.5;
  word-break: break-word;
}
.memory-item-del {
  background: none; border: none; color: var(--text-mute);
  cursor: pointer; font-size: 14px; padding: 0 4px; border-radius: 4px;
}
.memory-item-del:hover { background: rgba(220,38,38,0.10); color: var(--error); }
.memory-add {
  display: flex; gap: 6px; padding: 0 10px 14px;
}
.memory-add input {
  flex: 1; padding: 7px 10px; font-size: 12.5px;
  background: var(--bg); border: 1px solid var(--border);
  border-radius: var(--radius-md); color: var(--text);
  font-family: inherit; outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.memory-add input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.btn-mini {
  padding: 6px 10px; font-size: 12px;
  background: var(--accent); color: #fff; border: none;
  border-radius: var(--radius-md); cursor: pointer;
}
.btn-mini:hover { background: var(--accent-hover); }

/* === Main area === */
.app {
  flex: 1;
  display: flex; flex-direction: column;
  min-width: 0;
}
.topbar {
  height: 52px;
  border-bottom: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 20px;
  background: var(--bg);
  z-index: 10;
}
.topbar-left { display: flex; align-items: center; gap: 12px; }
.model-pill {
  font-size: 12px; padding: 4px 10px; border-radius: 999px;
  background: var(--bg-elev); border: 1px solid var(--border);
  color: var(--text-dim);
}
.btn {
  font-size: 13px; padding: 6px 14px; border-radius: var(--radius-md);
  border: 1px solid var(--border); background: var(--bg-elev);
  color: var(--text); cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
  font-family: inherit;
}
.btn:hover { background: var(--bg-hover); border-color: var(--text-mute); }
.btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); }
.btn-primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
.btn-icon { padding: 6px 8px; line-height: 1; }

/* Chat */
.chat {
  flex: 1; overflow-y: auto;
  padding: 28px 20px 20px;
  scroll-behavior: smooth;
}
.chat::-webkit-scrollbar { width: 8px; }
.chat::-webkit-scrollbar-track { background: transparent; }
.chat::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }

.msg {
  display: flex; gap: 12px; margin-bottom: 20px;
  max-width: 860px; margin-left: auto; margin-right: auto;
}
.msg.user { flex-direction: row-reverse; }
.msg-avatar {
  width: 32px; height: 32px; border-radius: 50%;
  flex-shrink: 0; display: grid; place-items: center;
  font-size: 14px; font-weight: 600;
}
.msg.user .msg-avatar { background: var(--accent-soft); color: var(--accent); }
.msg.assistant .msg-avatar {
  background: linear-gradient(135deg, var(--accent), #9b5bff);
  color: #fff;
}
.msg-body { flex: 1; min-width: 0; }
.msg-meta {
  font-size: 12px; color: var(--text-mute); margin-bottom: 4px;
  display: flex; align-items: center; gap: 8px;
}
.msg.user .msg-meta { justify-content: flex-end; }
.msg-content {
  padding: 12px 16px;
  border-radius: var(--radius-lg);
  line-height: 1.58;
  font-size: 14.5px;
  white-space: pre-wrap; word-break: break-word;
}
.msg.user .msg-content {
  background: var(--user-bubble); color: var(--user-bubble-text);
  border-bottom-right-radius: 4px;
}
.msg.assistant .msg-content {
  background: var(--assistant-bubble); color: var(--assistant-bubble-text);
  border-bottom-left-radius: 4px;
}
.msg-content pre {
  background: rgba(0,0,0,0.06);
  border-radius: var(--radius-sm);
  padding: 10px 12px; margin: 8px 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px; overflow-x: auto;
}
@media (prefers-color-scheme: dark) {
  .msg-content pre { background: rgba(255,255,255,0.06); }
}

/* Run meta */
.run-meta {
  display: flex; align-items: center; gap: 12px;
  font-size: 12px; color: var(--text-mute);
  margin-bottom: 8px; flex-wrap: wrap;
}
.run-meta-item { display: flex; align-items: center; gap: 4px; }
.run-meta-icon {
  width: 14px; height: 14px; border-radius: 4px;
  display: grid; place-items: center; font-size: 10px;
  background: var(--bg-hover); color: var(--text-dim);
}

/* Process details */
.process-details {
  margin-top: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-elev);
  overflow: hidden;
}
.process-details.collapsed .process-body { display: none; }
.process-details.collapsed .process-chevron { transform: rotate(-90deg); }
.process-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px; cursor: pointer; user-select: none;
  font-size: 12px; color: var(--text-dim);
  transition: background 0.15s;
}
.process-header:hover { background: var(--bg-hover); }
.process-body {
  border-top: 1px solid var(--border);
  padding: 8px;
  display: flex; flex-direction: column; gap: 6px;
  max-height: 400px; overflow-y: auto;
}
.process-step {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 6px 8px; border-radius: 6px;
  font-size: 12.5px;
}
.process-step.tool { background: var(--bg); }
.step-icon {
  width: 18px; height: 18px; border-radius: 4px; flex-shrink: 0;
  display: grid; place-items: center; font-size: 10px; margin-top: 1px;
}
.step-icon.think { background: var(--bg-hover); color: var(--text-mute); }
.step-icon.ok { background: rgba(22,163,74,0.12); color: var(--success); }
.step-icon.fail { background: rgba(220,38,38,0.12); color: var(--error); }
.step-content { flex: 1; min-width: 0; }
.step-title {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px; color: var(--text-dim); margin-bottom: 2px;
}
.step-body {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px; color: var(--text-mute);
  white-space: pre-wrap; word-break: break-all;
  max-height: 120px; overflow-y: auto;
  padding: 4px 6px; border-radius: 4px;
  background: var(--bg);
  border: 1px solid var(--border);
  margin-top: 4px;
}
.step-summary {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px; color: var(--text-mute);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* Typing (运行中) */
.thinking-indicator {
  display: flex; align-items: center; gap: 8px;
  padding: 4px 0; color: var(--text-mute); font-size: 13px;
}
.thinking-dots { display: flex; gap: 3px; }
.thinking-dots span {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--accent);
  animation: bounce 1.2s infinite ease-in-out both;
}
.thinking-dots span:nth-child(2) { animation-delay: 0.15s; }
.thinking-dots span:nth-child(3) { animation-delay: 0.3s; }

/* Empty state */
.empty {
  text-align: center; padding: 60px 20px; color: var(--text-mute);
}
.empty-logo {
  width: 56px; height: 56px; border-radius: 16px;
  background: linear-gradient(135deg, var(--accent), #9b5bff);
  display: grid; place-items: center;
  color: #fff; font-weight: 700; font-size: 22px;
  margin: 0 auto 16px; box-shadow: var(--shadow-lg);
}
.empty h2 { font-size: 18px; color: var(--text); margin-bottom: 6px; font-weight: 600; }
.empty p { font-size: 14px; margin-bottom: 24px; }
.suggestions {
  display: flex; flex-wrap: wrap; gap: 8px; justify-content: center;
  max-width: 520px; margin: 0 auto;
}
.suggestion {
  padding: 8px 14px; border-radius: 999px;
  background: var(--bg-elev); border: 1px solid var(--border);
  font-size: 13px; cursor: pointer; color: var(--text-dim);
  transition: all 0.15s;
}
.suggestion:hover { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); }

/* Composer */
.composer {
  border-top: 1px solid var(--border);
  padding: 14px 20px 18px;
  background: var(--bg);
}
.composer-inner {
  max-width: 860px; margin: 0 auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-elev);
  box-shadow: var(--shadow);
  transition: border-color 0.15s, box-shadow 0.15s;
}
.composer-inner:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.composer-textarea {
  display: block; width: 100%;
  border: none; outline: none; background: transparent;
  padding: 14px 16px 8px;
  font-family: inherit; font-size: 14.5px;
  color: var(--text); resize: none;
  max-height: 200px; min-height: 24px;
  line-height: 1.55;
}
.composer-footer {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 12px 10px;
}
.composer-hint { font-size: 11px; color: var(--text-mute); }
.send-btn {
  width: 34px; height: 34px; border-radius: 50%;
  background: var(--accent); color: #fff; border: none;
  display: grid; place-items: center; cursor: pointer;
  transition: background 0.15s, transform 0.1s, opacity 0.15s;
}
.send-btn:hover { background: var(--accent-hover); }
.send-btn:active { transform: scale(0.94); }
.send-btn:disabled { opacity: 0.4; cursor: default; }

/* Status toast */
.status-toast {
  position: fixed; top: 62px; right: 20px;
  background: var(--bg-elev); border: 1px solid var(--border);
  border-radius: var(--radius-md); padding: 8px 14px;
  font-size: 13px; color: var(--text-dim);
  box-shadow: var(--shadow-lg);
  display: flex; align-items: center; gap: 8px;
  opacity: 0; transform: translateY(-8px);
  transition: opacity 0.2s, transform 0.2s;
  z-index: 20;
}
.status-toast.show { opacity: 1; transform: translateY(0); }
.status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-mute); }
.status-dot.active { background: var(--accent); animation: pulse 1.5s infinite; }
.status-dot.done { background: var(--success); }
.status-dot.error { background: var(--error); }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
@keyframes bounce {
  0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
  40% { transform: translateY(-5px); opacity: 1; }
}

/* Sidebar toggle — always visible (desktop collapse + mobile drawer) */
.sidebar-toggle { display: grid; }
/* Desktop: sidebar collapses via .closed */
@media (min-width: 769px) {
  .sidebar { transition: width 0.25s ease; }
  .sidebar.closed { width: 0 !important; min-width: 0; overflow: hidden; border-right: none; }
  .sidebar.closed > * { display: none; }
}
/* Mobile: sidebar as overlay drawer */
@media (max-width: 768px) {
  .sidebar {
    position: fixed; left: 0; top: 0; bottom: 0;
    transform: translateX(-100%);
    box-shadow: var(--shadow-lg);
  }
  .sidebar.open { transform: translateX(0); }
}
</style>
</head>
<body>

<!-- === Sidebar (左侧抽屉) === -->
<aside class="sidebar" id="sidebar">
  <div class="sidebar-header">
    <div class="sidebar-brand">
      <div class="logo">F</div>
      <span class="name">Forge</span>
    </div>
    <div class="sidebar-actions">
      <button class="icon-btn" id="newChatBtnSide" title="新建对话">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
      </button>
      <button class="icon-btn" id="sidebarCloseBtn" title="关闭侧边栏">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>
  </div>

  <div class="sidebar-section-label">
    <span>会话</span>
    <button class="icon-btn" id="compactBtn" title="手动压缩上下文">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 12h8M3 18h18"/></svg>
    </button>
  </div>
  <div class="sidebar-list" id="sessionList">
    <div style="padding: 20px; text-align: center; color: var(--text-mute); font-size: 12px;">(无历史会话)</div>
  </div>

  <div class="sidebar-section-label"><span>用户偏好（长期记忆）</span></div>
  <div class="memory-list" id="memoryList">
    <div style="padding: 8px 0; text-align: center; color: var(--text-mute); font-size: 12px;">(还没有偏好记忆)</div>
  </div>
  <div class="memory-add">
    <input type="text" id="memoryInput" placeholder="添加偏好：例如 习惯用中文回答…" />
    <button class="btn-mini" id="memoryAddBtn">添加</button>
  </div>
</aside>

<!-- === Main app === -->
<div class="app">
  <header class="topbar">
    <div class="topbar-left">
      <button class="icon-btn sidebar-toggle" id="sidebarToggle" title="切换侧边栏">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
      </button>
      <span class="model-pill" id="modelPill">—</span>
      <span style="font-size: 12px; color: var(--text-mute);" id="activeSessionLabel">新建会话</span>
    </div>
    <div style="display: flex; gap: 8px;">
      <button class="btn btn-icon" id="newChatBtn" title="新建对话">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
      </button>
    </div>
  </header>

  <main class="chat" id="chat">
    <div class="empty" id="emptyState">
      <div class="empty-logo">F</div>
      <h2>你好，我是 Forge</h2>
      <p>我可以帮你写代码、改文件、跑命令，试试这些</p>
      <div class="suggestions">
        <div class="suggestion" data-suggestion="查看当前目录有哪些文件">查看当前目录</div>
        <div class="suggestion" data-suggestion="创建一个 hello.txt 文件，内容是 Hello Forge">创建文件</div>
        <div class="suggestion" data-suggestion="查一下今天的科技新闻">查科技新闻</div>
        <div class="suggestion" data-suggestion="运行 npm test 看看测试结果">跑测试</div>
      </div>
    </div>
  </main>

  <div class="composer">
    <div class="composer-inner">
      <textarea class="composer-textarea" id="input" rows="1" placeholder="给 Forge 下达任务…  (Enter 发送, Shift+Enter 换行)"></textarea>
      <div class="composer-footer">
        <span class="composer-hint">Enter 发送 · Shift+Enter 换行</span>
        <button class="send-btn" id="send" title="发送">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 5l7 7-7 7"/></svg>
        </button>
      </div>
    </div>
  </div>
</div>

<div class="status-toast" id="statusToast">
  <div class="status-dot" id="statusDot"></div>
  <span id="statusText">就绪</span>
</div>

<script>
/* ================================
 * 状态
 * ================================ */
var chat = document.getElementById('chat');
var inputEl = document.getElementById('input');
var sendBtn = document.getElementById('send');
var statusToast = document.getElementById('statusToast');
var statusDot = document.getElementById('statusDot');
var statusText = document.getElementById('statusText');
var modelPill = document.getElementById('modelPill');
var emptyState = document.getElementById('emptyState');
var newChatBtn = document.getElementById('newChatBtn');
var newChatBtnSide = document.getElementById('newChatBtnSide');
var compactBtn = document.getElementById('compactBtn');
var sidebar = document.getElementById('sidebar');
var sidebarToggle = document.getElementById('sidebarToggle');
var sessionList = document.getElementById('sessionList');
var memoryList = document.getElementById('memoryList');
var memoryInput = document.getElementById('memoryInput');
var memoryAddBtn = document.getElementById('memoryAddBtn');
var activeSessionLabel = document.getElementById('activeSessionLabel');

var running = false;
var currentSessionId = null;
var currentRun = { steps: [], runningMsg: null, toolCount: 0 };

/* ================================
 * 工具函数
 * ================================ */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, function(c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
  });
}
function showEmpty() { emptyState.style.display = chat.children.length === 1 ? 'block' : 'none'; }
function scrollBottom() { chat.scrollTop = chat.scrollHeight; }
function setStatus(text, kind) {
  statusText.textContent = text;
  statusDot.className = 'status-dot' + (kind ? ' ' + kind : '');
  statusToast.classList.add('show');
  clearTimeout(setStatus._t);
  if (kind === 'done' || kind === 'error') {
    setStatus._t = setTimeout(function() { statusToast.classList.remove('show'); }, 2000);
  }
}
function formatMs(ms) {
  if (ms == null) return '';
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(1) + 's';
}
function argsSummary(argsStr) {
  try {
    var obj = JSON.parse(argsStr || '{}');
    var keys = Object.keys(obj);
    if (keys.length === 0) return '';
    var k = keys[0];
    var v = obj[k];
    var vStr = typeof v === 'string' ? v : JSON.stringify(v);
    if (vStr.length > 30) vStr = vStr.slice(0, 27) + '...';
    return k + ': ' + vStr;
  } catch (e) {
    return argsStr ? argsStr.slice(0, 40) + (argsStr.length > 40 ? '...' : '') : '';
  }
}
function formatTime(iso) {
  try {
    var d = new Date(iso);
    var now = new Date();
    var diffMin = (now - d) / 60000;
    if (diffMin < 1) return '刚刚';
    if (diffMin < 60) return Math.floor(diffMin) + '分钟前';
    if (diffMin < 1440) return Math.floor(diffMin / 60) + '小时前';
    return (d.getMonth() + 1) + '/' + d.getDate();
  } catch { return iso; }
}

/* ================================
 * 会话列表 + 记忆列表 加载
 * ================================ */
async function loadSessions() {
  try {
    var r = await fetch('/api/sessions');
    var d = await r.json();
    currentSessionId = d.currentId;
    if (!d.sessions || d.sessions.length === 0) {
      sessionList.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-mute);font-size:12px">(无历史会话)</div>';
      return;
    }
    var html = '';
    d.sessions.forEach(function(s) {
      var active = s.id === currentSessionId ? ' active' : '';
      html +=
        '<div class="session-item' + active + '" data-id="' + esc(s.id) + '">' +
          '<div class="session-item-icon">💬</div>' +
          '<div class="session-item-body">' +
            '<div class="session-item-title">' + esc(s.summary || '(空会话)') + '</div>' +
            '<div class="session-item-meta">' + formatTime(s.updatedAt) + ' · ' + esc(s.model || '') + '</div>' +
          '</div>' +
          '<div class="session-item-actions">' +
            '<button class="icon-btn" data-action="resume" title="恢复">' +
              '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 0 1 15.5-6.4L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.4L3 16"/><path d="M3 21v-5h5"/></svg>' +
            '</button>' +
            '<button class="icon-btn" data-action="fork" title="分叉">' +
              '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="3" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="9" r="3"/><path d="M6 6v9M18 9c0 6-6 6-6 9"/></svg>' +
            '</button>' +
            '<button class="icon-btn" data-action="delete" title="删除">' +
              '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>' +
            '</button>' +
          '</div>' +
        '</div>';
    });
    sessionList.innerHTML = html;

    // 绑定：点击会话 → 恢复；按钮事件
    sessionList.querySelectorAll('.session-item').forEach(function(item) {
      var id = item.getAttribute('data-id');
      item.addEventListener('click', function(e) {
        // 按钮子元素阻止冒泡，所以判断点在按钮上不恢复
        if (e.target.closest('[data-action]')) return;
        resumeSession(id);
      });
      item.querySelectorAll('[data-action]').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          var act = btn.getAttribute('data-action');
          if (act === 'resume') resumeSession(id);
          else if (act === 'fork') forkSession(id);
          else if (act === 'delete') deleteSession(id);
        });
      });
    });
  } catch (e) {
    console.error(e);
  }
}

async function loadMemory() {
  try {
    var r = await fetch('/api/memory');
    var d = await r.json();
    if (!d.facts || d.facts.length === 0) {
      memoryList.innerHTML = '<div style="padding:8px 0;text-align:center;color:var(--text-mute);font-size:12px">(还没有偏好记忆)</div>';
      return;
    }
    memoryList.innerHTML = d.facts.map(function(f) {
      return '<div class="memory-item">' +
        '<div class="memory-item-text">' + esc('#' + f.id + ' ' + f.fact) + '</div>' +
        '<button class="memory-item-del" data-id="' + f.id + '" title="删除">×</button>' +
      '</div>';
    }).join('');
    memoryList.querySelectorAll('.memory-item-del').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var id = Number(btn.getAttribute('data-id'));
        fetch('/api/memory', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: id })
        }).then(function() { loadMemory(); setStatus('偏好已删除', 'done'); });
      });
    });
  } catch (e) { console.error(e); }
}

async function addMemory() {
  var t = memoryInput.value.trim();
  if (!t) return;
  memoryInput.value = '';
  await fetch('/api/memory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fact: t })
  });
  await loadMemory();
  setStatus('偏好已保存', 'done');
}

/* ================================
 * 会话操作
 * ================================ */
async function resumeSession(id) {
  setStatus('恢复会话…', 'active');
  var r = await fetch('/api/sessions/' + encodeURIComponent(id) + '/resume', { method: 'POST' });
  var d = await r.json();
  if (!d.ok) { setStatus('恢复失败', 'error'); return; }
  currentSessionId = id;
  activeSessionLabel.textContent = (d.summary || id).slice(0, 30);

  // 清空当前对话并回放（把历史渲染成气泡，用 user/assistant 对展示）
  chat.innerHTML = '';
  // 简单：清空空态提示
  if (emptyState) {
    chat.appendChild(emptyState);
    emptyState.style.display = 'none';
  }
  // 简化：不重放历史到 UI（避免消息过多），用一个提示气泡
  if (d.messageCount > 0) {
    var m = createMessage('assistant');
    var box = document.createElement('div');
    box.style.padding = '10px 0';
    box.style.fontSize = '13px';
    box.style.color = 'var(--text-dim)';
    box.textContent = '（已恢复会话：共 ' + d.messageCount + ' 条消息，历史上下文已自动带入）';
    m.contentEl.appendChild(box);
  }
  showEmpty();
  await loadSessions();
  setStatus('已恢复会话', 'done');
}

async function forkSession(id) {
  var r = await fetch('/api/sessions/' + encodeURIComponent(id) + '/fork', { method: 'POST' });
  var d = await r.json();
  if (!d.ok) { setStatus('分叉失败', 'error'); return; }
  setStatus('已分叉到 ' + d.newId.slice(0, 20), 'done');
  await loadSessions();
}

async function deleteSession(id) {
  if (!confirm('删除该会话？')) return;
  await fetch('/api/sessions/' + encodeURIComponent(id), { method: 'DELETE' });
  if (currentSessionId === id) {
    currentSessionId = null;
    chat.innerHTML = '';
    if (emptyState) { chat.appendChild(emptyState); showEmpty(); }
  }
  await loadSessions();
  setStatus('已删除', 'done');
}

async function newChat() {
  try { await fetch('/api/clear', { method: 'POST' }); } catch {}
  currentSessionId = null;
  activeSessionLabel.textContent = '新建会话';
  chat.innerHTML = '';
  modelPill.textContent = '—';
  currentRun = { steps: [], runningMsg: null, toolCount: 0 };
  if (emptyState) { chat.appendChild(emptyState); showEmpty(); }
  await loadSessions();
  setStatus('新建会话', 'done');
  inputEl.focus();
}

async function doCompact() {
  setStatus('正在 CHECKPOINT 压缩…', 'active');
  var r = await fetch('/api/compact', { method: 'POST' });
  var d = await r.json();
  if (d.ok && d.didCompact) {
    setStatus('压缩完成，节省 ' + d.saved + ' tokens', 'done');
  } else if (d.ok) {
    setStatus('上下文无需压缩', 'done');
  } else {
    setStatus('压缩失败: ' + (d.reason || ''), 'error');
  }
}

/* ================================
 * 聊天
 * ================================ */
function createMessage(role) {
  if (emptyState) emptyState.style.display = 'none';
  var wrap = document.createElement('div');
  wrap.className = 'msg ' + role;
  var avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = role === 'user' ? '你' : 'F';
  var body = document.createElement('div');
  body.className = 'msg-body';
  var meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.textContent = role === 'user' ? '你' : 'Forge';
  var content = document.createElement('div');
  content.className = 'msg-content';
  body.appendChild(meta);
  body.appendChild(content);
  wrap.appendChild(avatar);
  wrap.appendChild(body);
  chat.appendChild(wrap);
  return { wrap: wrap, content: body, contentEl: content };
}
function createThinkingMessage() {
  var msg = createMessage('assistant');
  msg.contentEl.innerHTML = '';
  var ind = document.createElement('div');
  ind.className = 'thinking-indicator';
  ind.innerHTML = '<span>思考中</span><div class="thinking-dots"><span></span><span></span><span></span></div>';
  msg.contentEl.appendChild(ind);
  return msg;
}

function buildProcessDetails(steps, toolCount) {
  if (steps.length === 0) return null;
  var wrap = document.createElement('div');
  wrap.className = 'process-details collapsed';
  var header = document.createElement('div');
  header.className = 'process-header';
  var title = document.createElement('span');
  title.textContent = '查看过程详情（共 ' + steps.length + ' 步 · ' + toolCount + ' 次工具调用）';
  var chev = document.createElement('span');
  chev.className = 'process-chevron';
  chev.textContent = '▾';
  header.appendChild(title); header.appendChild(chev);
  wrap.appendChild(header);
  var body = document.createElement('div');
  body.className = 'process-body';

  steps.forEach(function(step) {
    var row = document.createElement('div');
    row.className = 'process-step ' + (step.type === 'tool' ? 'tool' : 'think');
    var icon = document.createElement('div');
    if (step.type === 'think') {
      icon.className = 'step-icon think'; icon.textContent = '💭';
    } else {
      icon.className = 'step-icon ' + (step.ok ? 'ok' : 'fail');
      icon.textContent = step.ok ? '✓' : '✗';
    }
    row.appendChild(icon);
    var content = document.createElement('div');
    content.className = 'step-content';
    var titleEl = document.createElement('div');
    titleEl.className = 'step-title';
    titleEl.textContent = step.type === 'think' ? '思考' : (step.name + (step.ok ? '' : ' (失败)'));
    content.appendChild(titleEl);
    var summaryEl = document.createElement('div');
    summaryEl.className = 'step-summary';
    if (step.type === 'think') summaryEl.textContent = step.text ? step.text.slice(0, 80) : '';
    else summaryEl.textContent = argsSummary(step.args) || '(无参数)';
    content.appendChild(summaryEl);
    if (step.type === 'think' && step.text) {
      var b = document.createElement('div');
      b.className = 'step-body'; b.textContent = step.text;
      content.appendChild(b);
    }
    if (step.type === 'tool') {
      var a = document.createElement('div');
      a.className = 'step-body';
      a.textContent = '参数: ' + (step.args || '(无)');
      content.appendChild(a);
      var r = document.createElement('div');
      r.className = 'step-body';
      r.textContent = (step.ok ? '结果: ' : '失败: ') + (step.output || step.error || '(无)');
      content.appendChild(r);
    }
    row.appendChild(content);
    body.appendChild(row);
  });

  wrap.appendChild(body);
  header.addEventListener('click', function() { wrap.classList.toggle('collapsed'); });
  return wrap;
}

function render(ev) {
  switch (ev.type) {
    case 'start':
      modelPill.textContent = ev.model || '—';
      if (ev.sessionId) {
        currentSessionId = ev.sessionId;
        activeSessionLabel.textContent = ev.sessionId.slice(-17);
      }
      break;
    case 'assistant':
      if (ev.content) currentRun.steps.push({ type: 'think', text: ev.content });
      break;
    case 'tool_call':
      currentRun.steps.push({
        type: 'tool', name: ev.name, args: ev.arguments,
        ok: null, output: '', error: '',
      });
      currentRun.toolCount++;
      break;
    case 'tool_result':
      for (var i = currentRun.steps.length - 1; i >= 0; i--) {
        var s = currentRun.steps[i];
        if (s.type === 'tool' && s.ok === null && s.name === ev.name) {
          s.ok = ev.ok; s.output = ev.output || ''; s.error = ev.error || '';
          break;
        }
      }
      break;
    case 'compact':
      if (ev.didCompact) setStatus('自动压缩节省 ' + ev.savedTokens + ' tokens', 'done');
      break;
    case 'done': {
      running = false;
      setStatus('完成', 'done');
      if (currentRun.runningMsg) {
        var msg = currentRun.runningMsg;
        msg.contentEl.innerHTML = '';
        var meta = document.createElement('div');
        meta.className = 'run-meta';
        if (ev.elapsedMs != null)
          meta.innerHTML += '<span class="run-meta-item"><span class="run-meta-icon">⏱</span>' + esc(formatMs(ev.elapsedMs)) + '</span>';
        if (ev.rounds != null)
          meta.innerHTML += '<span class="run-meta-item"><span class="run-meta-icon">⟳</span>' + esc(ev.rounds) + ' 轮</span>';
        if (currentRun.toolCount > 0)
          meta.innerHTML += '<span class="run-meta-item"><span class="run-meta-icon">🔧</span>' + esc(currentRun.toolCount) + ' 次工具调用</span>';
        if (ev.tokenEstimate != null)
          meta.innerHTML += '<span class="run-meta-item"><span class="run-meta-icon">◌</span>' + esc(ev.tokenEstimate) + ' tokens</span>';
        msg.contentEl.appendChild(meta);

        var answer = document.createElement('div');
        answer.style.whiteSpace = 'pre-wrap';
        answer.style.lineHeight = '1.6';
        answer.style.fontSize = '14.5px';
        answer.textContent = ev.answer || '(无内容)';
        msg.contentEl.appendChild(answer);

        var details = buildProcessDetails(currentRun.steps, currentRun.toolCount);
        if (details) msg.contentEl.appendChild(details);
      }
      currentRun = { steps: [], runningMsg: null, toolCount: 0 };
      sendBtn.disabled = false;
      inputEl.focus();
      scrollBottom();
      loadSessions();  // 刷新会话列表（新建/更新了）
      loadMemory();    // 模型可能调用 memory(save) 新增了偏好
      break;
    }
    case 'error': {
      running = false; setStatus('出错', 'error');
      if (currentRun.runningMsg) {
        currentRun.runningMsg.contentEl.innerHTML = '';
        var eBox = document.createElement('div');
        eBox.style.cssText = 'background:rgba(220,38,38,0.12);color:var(--error);padding:12px 16px;border-radius:12px;font-size:14px;';
        eBox.textContent = '出错了: ' + ev.error;
        currentRun.runningMsg.contentEl.appendChild(eBox);
      }
      currentRun = { steps: [], runningMsg: null, toolCount: 0 };
      sendBtn.disabled = false;
      inputEl.focus();
      scrollBottom();
      break;
    }
  }
}

async function runTask() {
  if (running) return;
  var text = inputEl.value.trim();
  if (!text) return;
  running = true;
  inputEl.value = '';
  inputEl.style.height = 'auto';
  sendBtn.disabled = true;
  setStatus('运行中…', 'active');
  currentRun = { steps: [], runningMsg: null, toolCount: 0 };

  createMessage('user').contentEl.textContent = text;
  currentRun.runningMsg = createThinkingMessage();

  try {
    var resp = await fetch('/api/task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text })
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
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
        try { render(JSON.parse(line)); } catch (e) { console.warn('parse err', e, line); }
      }
    }
  } catch (e) {
    render({ type: 'error', error: e.message || String(e) });
  } finally {
    running = false;
    showEmpty();
  }
}

/* ================================
 * 事件绑定
 * ================================ */
inputEl.addEventListener('input', function() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
  sendBtn.disabled = inputEl.value.trim().length === 0 || running;
});
inputEl.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runTask(); }
});
sendBtn.addEventListener('click', runTask);
newChatBtn.addEventListener('click', newChat);
newChatBtnSide.addEventListener('click', newChat);
compactBtn.addEventListener('click', doCompact);
/* Sidebar toggle — desktop uses .closed, mobile uses .open (drawer overlay) */
function toggleSidebar() {
  var isMobile = window.innerWidth <= 768;
  if (isMobile) {
    sidebar.classList.toggle('open');
  } else {
    sidebar.classList.toggle('closed');
  }
}
sidebarToggle && sidebarToggle.addEventListener('click', toggleSidebar);
var sidebarCloseBtn = document.getElementById('sidebarCloseBtn');
sidebarCloseBtn && sidebarCloseBtn.addEventListener('click', function() {
  var isMobile = window.innerWidth <= 768;
  if (isMobile) sidebar.classList.remove('open');
  else sidebar.classList.add('closed');
});
memoryAddBtn.addEventListener('click', addMemory);
memoryInput.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') { e.preventDefault(); addMemory(); }
});
document.querySelectorAll('.suggestion').forEach(function(el) {
  el.addEventListener('click', function() {
    inputEl.value = el.dataset.suggestion;
    inputEl.focus(); runTask();
  });
});

/* ================================
 * 启动
 * ================================ */
loadSessions();
loadMemory();
inputEl.focus();
showEmpty();
</script>
</body>
</html>`;

function printBanner(config: AppConfig): void {
  console.log('Forge v0.1.0');
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
`);
}

await main();
