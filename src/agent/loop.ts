import { ChatMessage, ChatProvider, ChatResponse, ToolCall } from '../llm/types.js';
import { ToolRegistry } from '../tools/registry.js';
import { buildSystemMessage, compactContext } from './context.js';

export interface AgentLoopDeps {
  provider: ChatProvider;
  tools: ToolRegistry;
  cwd: string;
  approve: (toolName: string, args: Record<string, unknown>) => Promise<boolean>;
  maxRounds?: number;
  maxRetries?: number;
  commandTimeoutMs?: number;
  contextTokenBudget?: number;
  signal?: AbortSignal;
  longTermFacts?: string;
  /** 角色化：角色专属 prompt 前缀（拼在通用 system message 之前） */
  systemPromptPrefix?: string;
  /** 角色化：角色名称（供 UI 标记来源） */
  roleName?: string;
  /** 角色化：角色头像标识（供 UI 显示） */
  roleAvatar?: string;
  onToolCall?: (call: ToolCall) => void;
  onAssistantMessage?: (message: ChatMessage) => void;
  onToolResult?: (call: ToolCall, result: { ok: boolean; output: string; error?: string }) => void;
  onCompact?: (info: { didCompact: boolean; savedTokens: number; summary?: string }) => void;
}

export interface AgentResult {
  status: 'completed' | 'max_rounds' | 'error';
  answer?: string;
  error?: string;
  messages: ChatMessage[];
  rounds: number;
}

export async function runAgentTask(
  deps: AgentLoopDeps,
  userInput: string,
  history?: ChatMessage[],
): Promise<AgentResult> {
  const maxRounds = deps.maxRounds ?? 12;
  // 每次都用最新 system message（保证长期事实是最新的），
  // 即使 history 里有旧 system，也替换掉（消息里的 system role 只允许一个存在于入模序列）。
  const freshSystem = buildSystemMessage(deps.cwd, deps.longTermFacts, deps.systemPromptPrefix);
  const historyWithoutOldSystem =
    history && history.length > 0
      ? history.filter((m) => m.role !== 'system')
      : [];
  const messages: ChatMessage[] = [
    freshSystem,
    ...historyWithoutOldSystem,
    { role: 'user', content: userInput },
  ];

  for (let round = 0; round < maxRounds; round++) {
    const attempt = await chatWithRetry(deps, messages);
    if (!attempt.ok) {
      return {
        status: 'error',
        error: attempt.error,
        messages,
        rounds: round + 1,
      };
    }

    messages.push(attempt.response.message);
    deps.onAssistantMessage?.(attempt.response.message);
    const calls = attempt.response.message.tool_calls ?? [];
    if (calls.length === 0) {
      return {
        status: 'completed',
        answer: attempt.response.message.content ?? '',
        messages,
        rounds: round + 1,
      };
    }

    for (const call of calls) {
      deps.onToolCall?.(call);
      const result = await deps.tools.run(call.function.name, call.function.arguments, {
        cwd: deps.cwd,
        commandTimeoutMs: deps.commandTimeoutMs,
        approve: deps.approve,
      });
      const content = result.ok
        ? result.output || '(tool completed with empty output)'
        : `ERROR: ${result.error}`;
      messages.push({ role: 'tool', tool_call_id: call.id, content });
      deps.onToolResult?.(call, { ok: result.ok, output: result.output, error: result.error });
    }
  }

  return {
    status: 'max_rounds',
    error: `达到最大工具轮次 ${maxRounds}，任务未完成`,
    messages,
    rounds: maxRounds,
  };
}

type ChatAttempt = { ok: true; response: ChatResponse } | { ok: false; error: string };

async function chatWithRetry(deps: AgentLoopDeps, messages: ChatMessage[]): Promise<ChatAttempt> {
  const maxRetries = deps.maxRetries ?? 2;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (deps.signal?.aborted) {
      return { ok: false, error: '任务已被用户中止' };
    }
    try {
      // 使用新的分层压缩（含 LLM CHECKPOINT）
      const { messages: trimmed, didCompact, summary, tokenStats } = await compactContext(
        messages,
        deps.provider,
        deps.contextTokenBudget ?? 128_000,
      );
      if (didCompact) {
        deps.onCompact?.({ didCompact, savedTokens: tokenStats.saved, summary });
      }
      const response = await deps.provider.chat(
        {
          model: deps.provider.model,
          messages: trimmed,
          tools: deps.tools.definitions(),
        },
        deps.signal,
      );
      return { ok: true, response };
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries && !deps.signal?.aborted) {
        await sleep(300 * 2 ** attempt);
      }
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  return { ok: false, error: `模型调用失败：${message}` };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
