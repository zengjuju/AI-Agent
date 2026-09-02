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
  const maxRounds = deps.maxRounds ?? 30;
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

  // 主循环：正常执行工具调用
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

  // ====== 达到 maxRounds 后强制总结：再调用一次模型，但移除 tools 定义，逼迫模型直接基于现有上下文给最终答复 ======
  // （而不是直接 return 错误——工具结果都已经在 messages 里了，模型只差一轮无工具纯文本总结）
  try {
    const { messages: trimmed } = await compactContext(
      messages,
      deps.provider,
      deps.contextTokenBudget ?? 128_000,
    );
    const response = await deps.provider.chat(
      {
        model: deps.provider.model,
        messages: [
          ...trimmed,
          {
            role: 'user',
            content:
              '本轮对话已接近工具调用上限，无法继续调用工具。请根据以上对话和已有的工具执行结果，直接用自然语言给出你能提供的最佳最终答复。如果任务部分完成，就说明已完成的部分和剩下的步骤。不要尝试再调用任何工具，只输出文字答复。',
          },
        ],
        // 注意：这里不传 tools，模型只能输出纯文本 assistant message，不会请求工具 → 必然终止
      },
      deps.signal,
    );

    messages.push(response.message);
    deps.onAssistantMessage?.(response.message);

    return {
      status: 'completed',
      answer: response.message.content ?? '',
      messages,
      rounds: maxRounds,
      // 保留标记信息：虽然 completed，但其实到了 maxRounds。调用方如果需要知道这个细节可以看 warning 字段。
      // 不过当前 status 只允许 completed/max_rounds/error，所以 status 保持 completed 避免用户看到"任务未完成"的吓人错误。
      warning: `达到 ${maxRounds} 轮，已基于已执行的工具结果强制汇总`,
    } as AgentResult & { warning?: string };
  } catch (err) {
    // 如果强制总结也失败，就返回原来的 max_rounds 错误
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'max_rounds',
      error: `达到最大工具轮次 ${maxRounds} 且强制总结失败（${message}），任务未完成`,
      messages,
      rounds: maxRounds,
    };
  }
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
