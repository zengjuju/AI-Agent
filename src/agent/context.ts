import { ChatMessage, ChatProvider, ChatResponse } from '../llm/types.js';

/* ================================================================
 * Forge 分层上下文压缩系统
 *
 * 参考：Claude Code (三层) / Codex CLI (CHECKPOINT) / OpenCode (保护 zones)
 *
 * Layer 1  Token 估算        —— 按 token 而非条数计算预算
 * Layer 2  规则级修剪        —— 截断长 tool 输出、剥离 ANSI/进度条/空行
 * Layer 3  保护 zones + 滑动窗口 —— system/tool defs/最近 2 轮永不切
 * Layer 4  LLM CHECKPOINT 压缩 —— 超阈值时用模型生成交接摘要
 * ================================================================ */

/* ==================== 配置 ==================== */

export const COMPACT_CONFIG = {
  // 触发 LLM 摘要压缩的 token 阈值（模型上下文窗口的 80%）
  autoCompactTokenRatio: 0.8,
  // 压缩后保留的最近完整消息 token 预算
  compactRecentTokenBudget: 8_000,
  // 压缩后注入的摘要最大 token 预算
  compactSummaryTokenBudget: 4_000,
  // 单条 tool 输出截断上限（字符）
  maxToolOutputChars: 2_000,
  // 保护 zones：最近 N 轮对话永不切（每轮 = user + assistant + tool_results）
  protectedRecentRounds: 2,
};

/* ==================== Token 估算器 ==================== */

/**
 * 简单 token 估算：
 * - 中文/日文/汉字：约 1.5 chars/token
 * - 英文/数字/标点：约 4 chars/token
 * - JSON 结构（tool_call arguments）：额外 +20% 开销
 *
 * 偏差通常在 ±15% 内，足够做工程级预算管理。
 */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    // CJK Unified Ideographs + Extended + Symbols + Fullwidth
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x20000 && code <= 0x2a6df) ||
      (code >= 0xff00 && code <= 0xffef) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0x3040 && code <= 0x30ff)
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk / 1.5 + other / 4);
}

export function estimateMessageTokens(msg: ChatMessage): number {
  let total = 0;
  // role + 协议开销
  total += 4;
  if (msg.content) total += estimateTokens(msg.content);
  if (msg.tool_call_id) total += estimateTokens(msg.tool_call_id);
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      total += estimateTokens(tc.function.name);
      total += Math.ceil(estimateTokens(tc.function.arguments) * 1.2); // JSON 开销
    }
  }
  return total;
}

export function estimateTotalTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

/* ==================== Layer 2: 规则级修剪 ==================== */

/** 剥离 ANSI 转义码 */
function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '');
}

/** 截断 tool 输出，保留头部和尾部（错误堆栈通常在尾部） */
function truncateToolOutput(text: string, maxChars: number): string {
  const clean = stripAnsi(text).replace(/\n{3,}/g, '\n\n').trim();
  if (clean.length <= maxChars) return clean;
  const head = Math.floor(maxChars * 0.65);
  const tail = maxChars - head - 40;
  return (
    clean.slice(0, head) +
    `\n\n… (截断 ${clean.length - maxChars} chars)\n\n` +
    clean.slice(-tail)
  );
}

/**
 * Layer 2 规则修剪：逐条处理 messages 中过长的 tool 输出。
 * 不删消息，只缩短 content。
 */
export function rulePrune(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (m.role === 'tool' && m.content && m.content.length > COMPACT_CONFIG.maxToolOutputChars) {
      return { ...m, content: truncateToolOutput(m.content, COMPACT_CONFIG.maxToolOutputChars) };
    }
    if (m.role === 'assistant' && m.content && m.content.length > COMPACT_CONFIG.maxToolOutputChars * 2) {
      // assistant 文本如果超长也修剪
      return { ...m, content: truncateToolOutput(m.content, COMPACT_CONFIG.maxToolOutputChars * 2) };
    }
    return m;
  });
}

/* ==================== Layer 3: 保护 zones + 智能滑动窗口 ==================== */

/**
 * 找到最后 N 轮对话的起始位置。
 * 一轮 = user 消息 + 紧随其后的 assistant + tool 消息。
 * 返回该起始 index（含）。
 */
function findLastRoundsStart(messages: ChatMessage[], rounds: number): number {
  if (rounds <= 0) return messages.length;
  let remainingUserMsgs = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      remainingUserMsgs++;
      if (remainingUserMsgs >= rounds) return i;
    }
  }
  return messages.length; // 没找到足够的 user 消息，全部保留
}

/**
 * 确保 tool 消息与其前一条 assistant(tool_calls) 不分离。
 * 如果滑动窗口切到了 tool 消息，把对应的 assistant 补进来。
 */
function repairOrphanToolMessages(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'tool') {
      // 检查前一条是否是带 tool_calls 的 assistant
      const prev = result[result.length - 1];
      if (!prev || prev.role !== 'assistant' || !prev.tool_calls || prev.tool_calls.length === 0) {
        // 找原始 messages 中这条 tool 消息的前置 assistant
        for (let j = i - 1; j >= 0; j--) {
          const candidate = messages[j];
          if (candidate.role === 'assistant' && candidate.tool_calls && candidate.tool_calls.length > 0) {
            // 检查这个 assistant 是否真的产生了当前 tool_call_id
            if (m.tool_call_id && candidate.tool_calls.some((tc) => tc.id === m.tool_call_id)) {
              result.push(candidate);
              break;
            }
          }
          // 遇到 user 或 system 就停——tool_call_id 可能属于更前面的 assistant
          if (candidate.role === 'user' || candidate.role === 'system') break;
        }
      }
      result.push(m);
    } else {
      result.push(m);
    }
  }
  return result;
}

/**
 * Layer 3: 按 token 预算做滑动窗口。
 *
 * 保护 zones（永不切）：
 *   [0] system prompt
 *   最后 protectedRecentRounds 轮完整对话
 *
 * 中间区域：按 token 从旧到新累加，超预算就丢旧的。
 * 最终结果过 repairOrphanToolMessages 修复。
 */
export function smartTrim(
  messages: ChatMessage[],
  budgetTokens: number,
  protectedRounds = COMPACT_CONFIG.protectedRecentRounds,
): ChatMessage[] {
  if (messages.length === 0) return messages;

  // 先过规则修剪
  const pruned = rulePrune(messages);

  // 算总 token
  const total = estimateTotalTokens(pruned);
  if (total <= budgetTokens) return pruned; // 没超，直接返回

  const system = pruned[0];
  const rest = pruned.slice(1);

  // 分离保护 zone（最近 N 轮）和可剪 zone
  const protectedStart = findLastRoundsStart(rest, protectedRounds);
  const protectedZone = rest.slice(protectedStart);
  const droppableZone = rest.slice(0, protectedStart);

  // 保护 zone 必须完整保留
  const protectedTokens = estimateTotalTokens([system, ...protectedZone]);
  if (protectedTokens > budgetTokens) {
    // 保护 zone 本身就超了——只能硬切最近的
    return repairOrphanToolMessages([system, ...protectedZone].slice(-50));
  }

  // 给可剪 zone 分配剩余预算
  let remaining = budgetTokens - protectedTokens;

  // 从旧到新累加，超了就丢
  const keptOld: ChatMessage[] = [];
  for (const m of droppableZone) {
    const t = estimateMessageTokens(m);
    if (remaining - t >= 0) {
      keptOld.push(m);
      remaining -= t;
    } else {
      // 丢，但跳过中间的 tool 消息（如果其 assistant 被丢了）
      continue;
    }
  }

  // 组装 + 修复孤儿
  const combined = [system, ...keptOld, ...protectedZone];
  return repairOrphanToolMessages(combined);
}

/* ==================== Layer 4: LLM CHECKPOINT 压缩 ==================== */

/** 压缩后的消息中注入的 CHECKPOINT 系统提示词 */
export const CHECKPOINT_PREFIX = [
  'CONTEXT CHECKPOINT — 会话历史已压缩。',
  '',
  '以下是此前对话的结构化摘要（由另一个模型生成）。',
  '请将此摘要视为可靠的上下文基础，在此之上继续工作。',
  '原始对话已被压缩，不要尝试"恢复"或"重跑"摘要中提到的操作。',
  '',
].join('\n');

/**
 * 生成 CHECKPOINT 摘要的 prompt。
 * 参考 Codex CLI 和 Claude Code 的 compact prompt。
 */
export function buildCompactPrompt(history: ChatMessage[]): string {
  // 只把历史（不含 system）喂给模型做摘要
  const historyText = history
    .filter((m) => m.role !== 'system')
    .map((m) => {
      if (m.role === 'user') return `[用户] ${m.content}`;
      if (m.role === 'assistant') {
        const parts: string[] = [];
        if (m.content) parts.push(m.content);
        if (m.tool_calls?.length) {
          parts.push(`→ 调用工具: ${m.tool_calls.map((tc) => `${tc.function.name}(${tc.function.arguments.slice(0, 200)})`).join(', ')}`);
        }
        return `[助手] ${parts.join(' ')}`;
      }
      if (m.role === 'tool') return `[工具结果 ${m.tool_call_id}] ${m.content?.slice(0, 500)}`;
      return '';
    })
    .join('\n');

  return [
    '你正在执行 CONTEXT CHECKPOINT COMPACTION。',
    '为下一个模型生成一份结构化的交接摘要，让它能无缝接手当前任务。',
    '',
    '请务必包含以下要点（用简洁的中文条目列出）：',
    '1. 当前进度和已完成的关键操作（按时间顺序）',
    '2. 涉及的文件路径、代码变更、命令执行结果',
    '3. 用户的明确需求和约束条件',
    '4. 剩余待办事项和明确的下一步',
    '5. 关键数据、错误信息、需要特别注意的细节',
    '',
    '要求：',
    '- 控制在 400 字以内',
    '- 用 Markdown 列表，方便扫描',
    '- 不要输出与交接无关的客套话',
    '',
    '========== 以下是原始对话历史 ==========',
    historyText.slice(0, 30_000), // 摘要 prompt 本身也不能太长
    '========== 历史结束 ==========',
  ].join('\n');
}

/**
 * Layer 4: 执行 CHECKPOINT 压缩。
 *
 * 流程：
 * 1. 调用模型生成摘要
 * 2. 组装新上下文：system + 摘要(system 角色) + 最近 N 条完整消息
 * 3. 返回压缩后的 messages（原始历史完整保留）
 */
export async function runCheckpointCompact(
  messages: ChatMessage[],
  provider: ChatProvider,
  providerModelContextBudget?: number,
): Promise<{ compacted: ChatMessage[]; summary: string; savedTokens: number }> {
  if (messages.length === 0) {
    return { compacted: messages, summary: '', savedTokens: 0 };
  }

  const originalTokens = estimateTotalTokens(messages);

  // 用独立的 compact prompt 调模型生成摘要
  const compactPrompt = buildCompactPrompt(messages);
  const summaryResp: ChatResponse = await provider.chat({
    model: provider.model,
    messages: [{ role: 'user', content: compactPrompt }],
    maxTokens: Math.floor(COMPACT_CONFIG.compactSummaryTokenBudget * 1.2), // 留余量
  });
  const summaryText = summaryResp.message.content ?? '(压缩失败：模型未返回摘要)';

  // 组装 CHECKPOINT 摘要消息（用 system 角色注入）
  const checkpointMsg: ChatMessage = {
    role: 'system',
    content: CHECKPOINT_PREFIX + summaryText,
  };

  // 保留最近的完整消息（按 token 预算）
  const rest = messages[0].role === 'system' ? messages.slice(1) : messages;
  let recentTokens = 0;
  const recent: ChatMessage[] = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    const t = estimateMessageTokens(rest[i]);
    if (recentTokens + t > COMPACT_CONFIG.compactRecentTokenBudget) break;
    recent.unshift(rest[i]);
    recentTokens += t;
  }

  const system = messages[0].role === 'system' ? messages[0] : null;
  const compacted = [
    ...(system ? [system] : []),
    checkpointMsg,
    ...repairOrphanToolMessages(recent),
  ];

  const newTokens = estimateTotalTokens(compacted);
  return {
    compacted,
    summary: summaryText,
    savedTokens: originalTokens - newTokens,
  };
}

/* ==================== 统一入口 ==================== */

export interface CompactResult {
  messages: ChatMessage[];
  didCompact: boolean;
  summary?: string;
  tokenStats: { original: number; afterPrune: number; final: number; saved: number };
}

/**
 * Forge 上下文压缩统一入口。
 * 按 Layer 顺序执行，到达阈值才触发更高层。
 *
 * @param messages      完整对话历史
 * @param provider      模型提供者（用于 Layer 4 摘要）
 * @param contextBudget 模型上下文窗口 token 上限（默认 128k）
 */
export async function compactContext(
  messages: ChatMessage[],
  provider?: ChatProvider,
  contextBudget = 128_000,
): Promise<CompactResult> {
  const original = estimateTotalTokens(messages);
  let current = messages;
  let didCompact = false;
  let summary: string | undefined;

  // Layer 2: 规则修剪（总是执行，低成本高收益）
  current = rulePrune(current);
  const afterPrune = estimateTotalTokens(current);

  // Layer 3: 按 token 做滑动窗口（如果超 80% 阈值）
  const autoCompactThreshold = Math.floor(contextBudget * COMPACT_CONFIG.autoCompactTokenRatio);
  if (estimateTotalTokens(current) > autoCompactThreshold) {
    const windowBudget = Math.floor(contextBudget * 0.6); // 滑动窗口用 60% 预算
    current = smartTrim(current, windowBudget);
    didCompact = true;
  }

  // Layer 4: 如果还超，尝试 LLM 摘要
  if (provider && estimateTotalTokens(current) > autoCompactThreshold) {
    try {
      const result = await runCheckpointCompact(current, provider);
      current = result.compacted;
      summary = result.summary;
      didCompact = true;
    } catch {
      // 摘要失败不阻塞，退回滑动窗口
    }
  }

  const final = estimateTotalTokens(current);
  return {
    messages: current,
    didCompact,
    summary,
    tokenStats: { original, afterPrune, final, saved: original - final },
  };
}

/* ==================== 兼容旧接口 ==================== */

/**
 * 兼容旧 trimMessages 接口（纯规则修剪 + 滑动窗口，不用 LLM）。
 * 保留给不需要压缩的场景。
 */
export function trimMessages(messages: ChatMessage[], maxMessages = 50): ChatMessage[] {
  if (messages.length <= maxMessages) return messages;
  const system = messages[0];
  const rest = messages.slice(1);
  let kept = rest.slice(-(maxMessages - 1));
  if (kept[0]?.role === 'tool') {
    const index = rest.indexOf(kept[0]);
    if (index > 0) kept = [rest[index - 1] as ChatMessage, ...kept];
  }
  return [system, ...kept].filter((m): m is ChatMessage => Boolean(m));
}

/* ==================== System Message 构建 ==================== */

export function buildSystemMessage(cwd: string, longTermFactText = ''): ChatMessage {
  const corePrompt = [
    '你是 Forge，一个运行在本地终端中的编程智能体。',
    `当前工作目录：${cwd}`,
    '',
    '可用工具列表（优先使用内置工具，不要写 Python/脚本重复造轮子）：',
    '- list_dir: 列出目录内容',
    '- read_file: 读取文件',
    '- write_file: 写入文件（需审批）',
    '- run_command: 执行 shell 命令（需审批）',
    '- fetch_url: 抓取任意 http/https URL 的文本内容，自动识别 RSS/HTML',
    '- search_news: 查询最新新闻头条（内置 Google News RSS，支持中文/英文/按主题筛选）',
    '- memory: 管理用户的长期偏好（save/list/forget），记住用户说过的习惯/约束',
    '',
    '使用规则：',
    '1. 需要了解文件或环境时，先调用工具获取真实信息，不要编造内容。',
    '2. 当用户让你实现某个功能、写代码、给出方案时，直接在回复中用 markdown 代码块输出完整代码内容，不要调用 write_file 在本地创建文件。只有当用户明确说"创建文件/保存到文件/写入到 xxx 文件"时，才使用 write_file。',
    '3. 写文件、执行命令前先向用户说明计划；系统会另行征求用户批准。',
    '4. 工具失败时，分析错误并尝试修正参数或改用其他方案。',
    '5. 任务完成后，用最终答复总结你做了什么和结果如何。',
    '6. 用户明确表达偏好/约束时，用 memory(save) 保存，避免下次重复询问。',
    '7. 不要滥用 memory 记录临时结论——只记录跨会话稳定存在的用户偏好、习惯、硬性约束。',
    '',
    '重要 —— 不要写 Python/脚本来完成以下任务，直接用内置工具：',
    '- 查新闻/头条 → 用 search_news 或 fetch_url("https://news.google.com/rss?...")',
    '- 抓网页内容 → 用 fetch_url',
    '- 读文件/列目录 → 用 read_file / list_dir',
    '写 Python 脚本再 run_command 执行是多余的，直接用内置工具一步到位。',
  ].join('\n');

  const content = longTermFactText ? corePrompt + '\n' + longTermFactText : corePrompt;

  return { role: 'system', content };
}
