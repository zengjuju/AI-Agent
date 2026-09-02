/* ================================================================
 * Forge 多 Agent 编排器
 *
 * 范式 1 (Planner-Worker) + 范式 2 (角色专业化) 混合版
 *
 * 流程：
 *   用户请求 → Planner 拆子任务 → Worker 并行执行 → Reviewer 审查 → 汇总
 *
 * 每个 Worker 带角色专属 prompt + 工具白名单，
 * 模型在物理上无法调用不属于自己的工具。
 * ================================================================ */

import { ChatProvider, ChatMessage } from '../llm/types.js';
import { ToolRegistry, defaultTools } from '../tools/registry.js';
import { Tool } from '../tools/types.js';
import { runAgentTask, AgentResult } from './loop.js';
import { ROLES, Role, RoleId } from './roles.js';
import { buildSystemMessage } from './context.js';

/* ==================== 类型定义 ==================== */

export interface SubTask {
  id: number;
  title: string;
  description: string;
  role: 'coder' | 'researcher' | 'architect';
  dependsOn: number[];
  acceptanceCriteria: string;
}

export interface SubTaskResult {
  taskId: number;
  role: string;
  roleAvatar: string;
  title: string;
  answer: string;
  elapsedMs: number;
  status: 'completed' | 'error' | 'max_rounds';
  error?: string;
}

export interface OrchestratorDeps {
  provider: ChatProvider;
  tools: ToolRegistry;
  cwd: string;
  longTermFacts: string;
  maxRetries: number;
  commandTimeoutMs: number;
  contextTokenBudget: number;
  approve: (toolName: string, args: Record<string, unknown>) => Promise<boolean>;
}

export type OrchestratorEvent =
  | { type: 'plan'; subtasks: SubTask[] }
  | { type: 'subtask_start'; taskId: number; role: string; roleAvatar: string; title: string }
  | { type: 'subtask_assistant'; taskId: number; role: string; roleAvatar: string; content: string | null; toolCalls?: { name: string; arguments: string }[] }
  | { type: 'subtask_tool_call'; taskId: number; role: string; name: string; arguments: string }
  | { type: 'subtask_tool_result'; taskId: number; role: string; name: string; ok: boolean; output: string; error?: string }
  | { type: 'subtask_done'; taskId: number; role: string; roleAvatar: string; answer: string; elapsedMs: number; status: string }
  | { type: 'review'; passed: boolean; score: number; review: string }
  | { type: 'summary'; summary: string; elapsedMs: number }
  | { type: 'orchestrator_error'; error: string };

/* ==================== 编排器 ==================== */

export class Orchestrator {
  constructor(private deps: OrchestratorDeps) {}

  /** 主入口：判断复杂度 → 规划 → 执行 → 审查 → 汇总 */
  async run(
    userRequest: string,
    history: ChatMessage[],
    emit: (event: OrchestratorEvent) => void,
  ): Promise<{ answer: string; rounds: number; messages: ChatMessage[] }> {
    const totalStart = Date.now();

    // 1. 规划
    let subtasks: SubTask[];
    try {
      subtasks = await this.plan(userRequest);
    } catch (err) {
      emit({ type: 'orchestrator_error', error: `规划失败: ${err instanceof Error ? err.message : String(err)}` });
      return {
        answer: `抱歉，任务规划失败了：${err instanceof Error ? err.message : String(err)}\n\n请尝试将任务拆分为更小的步骤分别提问。`,
        rounds: 0,
        messages: [],
      };
    }

    // 只拆出 1 个子任务 → 不值得编排，退回单 Agent
    if (subtasks.length <= 1) {
      return {
        answer: '',
        rounds: 0,
        messages: [],
      };
    }

    emit({ type: 'plan', subtasks });

    // 2. 执行
    const results = await this.execute(subtasks, emit);

    // 3. 审查
    let reviewPassed = true;
    let reviewScore = 100;
    let reviewText = '';
    try {
      const review = await this.review(userRequest, subtasks, results);
      reviewPassed = review.passed;
      reviewScore = review.score;
      reviewText = review.review;
      emit({ type: 'review', passed: review.passed, score: review.score, review: review.review });
    } catch {
      // Reviewer 失败不影响最终输出
    }

    // 4. 审查不过 → 修正（最多 1 轮）
    if (!reviewPassed) {
      const fixResults = await this.executeFixRound(subtasks, results, reviewText, emit);
      const reReview = await this.review(userRequest, subtasks, fixResults);
      emit({ type: 'review', passed: reReview.passed, score: reReview.score, review: reReview.review });
      results.splice(0, results.length, ...fixResults);
    }

    // 5. 汇总
    const summary = this.summarize(userRequest, subtasks, results, reviewText, reviewScore);
    const elapsedMs = Date.now() - totalStart;
    emit({ type: 'summary', summary, elapsedMs });

    return {
      answer: summary,
      rounds: subtasks.length,
      messages: [],
    };
  }

  /* ==================== 阶段 1: 规划 ==================== */
  private async plan(userRequest: string): Promise<SubTask[]> {
    const plannerRole = ROLES.planner;

    const response = await this.deps.provider.chat({
      model: this.deps.provider.model,
      messages: [
        { role: 'system', content: plannerRole.systemPrompt },
        { role: 'user', content: userRequest },
      ],
    });

    const content = response.message.content ?? '[]';
    const subtasks = this.parseSubtasks(content);

    if (subtasks.length === 0) {
      throw new Error('Planner 未输出有效的子任务 JSON');
    }

    // 校验角色合法性和依赖
    const validRoles = new Set(['coder', 'researcher', 'architect']);
    for (const t of subtasks) {
      if (!validRoles.has(t.role)) {
        throw new Error(`子任务 #${t.id} 的角色 "${t.role}" 无效`);
      }
    }

    return subtasks;
  }

  private parseSubtasks(content: string): SubTask[] {
    // 提取 JSON 数组（容忍 markdown 代码块包裹）
    let jsonStr = content.trim();
    // 去掉可能的 ```json ... ``` 包裹
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }

    // 尝试找到 JSON 数组的起始和结束
    const start = jsonStr.indexOf('[');
    const end = jsonStr.lastIndexOf(']');
    if (start === -1 || end === -1) {
      return [];
    }
    jsonStr = jsonStr.slice(start, end + 1);

    try {
      const parsed = JSON.parse(jsonStr) as unknown[];
      if (!Array.isArray(parsed)) return [];

      return parsed
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        .map((item, index) => ({
          id: Number(item.id ?? index + 1),
          title: String(item.title ?? `子任务 ${index + 1}`),
          description: String(item.description ?? ''),
          role: String(item.role ?? 'coder') as 'coder' | 'researcher' | 'architect',
          dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.map(Number) : [],
          acceptanceCriteria: String(item.acceptanceCriteria ?? '完成描述中的任务'),
        }))
        .slice(0, 4);
    } catch {
      return [];
    }
  }

  /* ==================== 阶段 2: 调度执行 ==================== */
  private async execute(
    subtasks: SubTask[],
    emit: (event: OrchestratorEvent) => void,
  ): Promise<SubTaskResult[]> {
    const results = new Map<number, SubTaskResult>();
    const remaining = [...subtasks];

    while (remaining.length > 0) {
      // 找出所有依赖已完成的子任务
      const ready = remaining.filter((t) => t.dependsOn.every((depId) => results.has(depId)));

      if (ready.length === 0) {
        // 检测循环依赖
        const stuck = remaining.map((t) => `#${t.id}`).join(', ');
        console.warn(`[Orchestrator] 检测到可能的循环依赖，跳过: ${stuck}`);
        // 把剩余任务标记为错误
        for (const t of remaining) {
          results.set(t.id, {
            taskId: t.id,
            role: ROLES[t.role].name,
            roleAvatar: ROLES[t.role].avatar,
            title: t.title,
            answer: '因循环依赖未能执行',
            elapsedMs: 0,
            status: 'error',
            error: '循环依赖',
          });
        }
        break;
      }

      // 并行执行所有就绪的子任务
      const batchResults = await Promise.all(
        ready.map((task) => this.runWorker(task, results, emit)),
      );

      // 收集结果并从剩余队列移除
      for (let i = 0; i < ready.length; i++) {
        results.set(ready[i].id, batchResults[i]);
        const idx = remaining.indexOf(ready[i]);
        if (idx >= 0) remaining.splice(idx, 1);
      }
    }

    return Array.from(results.values());
  }

  /* ==================== 阶段 3: Worker 执行 ==================== */
  private async runWorker(
    task: SubTask,
    priorResults: Map<number, SubTaskResult>,
    emit: (event: OrchestratorEvent) => void,
  ): Promise<SubTaskResult> {
    const role = ROLES[task.role];
    const start = Date.now();

    emit({
      type: 'subtask_start',
      taskId: task.id,
      role: role.name,
      roleAvatar: role.avatar,
      title: task.title,
    });

    // 构造 Worker 上下文
    const contextParts: string[] = [
      `## 你的任务\n${task.title}`,
      `\n## 详细说明\n${task.description}`,
      `\n## 验收标准\n${task.acceptanceCriteria}`,
    ];

    // 注入依赖任务的产出
    for (const depId of task.dependsOn) {
      const depResult = priorResults.get(depId);
      if (depResult) {
        contextParts.push(`\n## 上游任务 #${depId} (${depResult.role}) 的产出\n${depResult.answer}`);
      }
    }

    // 创建角色化工具集
    const roleTools = this.createRoleToolSet(role);

    // 复用 runAgentTask，注入角色 prompt + 子集工具
    const result: AgentResult = await runAgentTask(
      {
        provider: this.deps.provider,
        tools: roleTools,
        cwd: this.deps.cwd,
        maxRounds: 16,
        maxRetries: this.deps.maxRetries,
        commandTimeoutMs: this.deps.commandTimeoutMs,
        contextTokenBudget: this.deps.contextTokenBudget,
        longTermFacts: this.deps.longTermFacts,
        systemPromptPrefix: role.systemPrompt,
        roleName: role.name,
        roleAvatar: role.avatar,
        approve: this.deps.approve,
        onAssistantMessage: (message) => {
          emit({
            type: 'subtask_assistant',
            taskId: task.id,
            role: role.name,
            roleAvatar: role.avatar,
            content: message.content,
            toolCalls: (message.tool_calls ?? []).map((call) => ({
              name: call.function.name,
              arguments: call.function.arguments,
            })),
          });
        },
        onToolCall: (call) => {
          emit({
            type: 'subtask_tool_call',
            taskId: task.id,
            role: role.name,
            name: call.function.name,
            arguments: call.function.arguments,
          });
        },
        onToolResult: (call, toolResult) => {
          emit({
            type: 'subtask_tool_result',
            taskId: task.id,
            role: role.name,
            name: call.function.name,
            ok: toolResult.ok,
            output: toolResult.output,
            error: toolResult.error,
          });
        },
      },
      contextParts.join('\n'),
    );

    const elapsedMs = Date.now() - start;
    const answer = result.answer ?? result.error ?? '(无输出)';

    emit({
      type: 'subtask_done',
      taskId: task.id,
      role: role.name,
      roleAvatar: role.avatar,
      answer,
      elapsedMs,
      status: result.status,
    });

    return {
      taskId: task.id,
      role: role.name,
      roleAvatar: role.avatar,
      title: task.title,
      answer,
      elapsedMs,
      status: result.status,
      error: result.error,
    };
  }

  /* ==================== 角色化工具集 ==================== */
  private createRoleToolSet(role: Role): ToolRegistry {
    // 从全局工具集中提取白名单工具
    const roleToolNames = new Set(role.allowedTools);
    const toolsForRole: Tool[] = defaultTools.filter((t) => roleToolNames.has(t.name));

    // Planner 没有工具
    if (role.id === 'planner') {
      return new ToolRegistry([]);
    }

    return new ToolRegistry(toolsForRole);
  }

  /* ==================== 阶段 4: 审查 ==================== */
  private async review(
    userRequest: string,
    subtasks: SubTask[],
    results: SubTaskResult[],
  ): Promise<{ passed: boolean; score: number; review: string }> {
    const reviewerRole = ROLES.reviewer;

    const reviewContext = [
      `## 原始用户请求\n${userRequest}`,
      `\n## 子任务清单`,
      ...subtasks.map((t) => `- #${t.id} [${t.role}] ${t.title}\n  验收: ${t.acceptanceCriteria}`),
      `\n## 各 Worker 产出`,
      ...results.map((r) => `### #${r.taskId} (${r.role}) ${r.title}\n${r.answer}`),
    ].join('\n');

    const response = await this.deps.provider.chat({
      model: this.deps.provider.model,
      messages: [
        { role: 'system', content: reviewerRole.systemPrompt },
        { role: 'user', content: reviewContext },
      ],
    });

    const review = response.message.content ?? '';
    const scoreMatch = review.match(/(\d+)\s*\/\s*100|评分[:：]\s*(\d+)/);
    const score = scoreMatch ? parseInt(scoreMatch[1] || scoreMatch[2]) : 100;

    return {
      passed: score >= 60,
      score,
      review,
    };
  }

  /* ==================== 修正轮 ==================== */
  private async executeFixRound(
    subtasks: SubTask[],
    results: SubTaskResult[],
    reviewText: string,
    emit: (event: OrchestratorEvent) => void,
  ): Promise<SubTaskResult[]> {
    // 简化：让有问题的子任务重新执行，带上审查意见
    const fixResults: SubTaskResult[] = [];
    const priorMap = new Map(results.map((r) => [r.taskId, r] as const));

    for (const task of subtasks) {
      const prior = priorMap.get(task.id);
      if (!prior) continue;

      const role = ROLES[task.role];
      const start = Date.now();

      emit({
        type: 'subtask_start',
        taskId: task.id,
        role: role.name + '(修正)',
        roleAvatar: role.avatar,
        title: task.title + ' [修正]',
      });

      const contextParts: string[] = [
        `## 你的任务（修正轮）\n${task.title}`,
        `\n## 详细说明\n${task.description}`,
        `\n## 验收标准\n${task.acceptanceCriteria}`,
        `\n## 审查员反馈\n${reviewText}`,
        `\n## 你的上一次产出\n${prior.answer}`,
        `\n请根据审查反馈修正你的产出。`,
      ];

      for (const depId of task.dependsOn) {
        const depResult = fixResults.find((r) => r.taskId === depId) ?? priorMap.get(depId);
        if (depResult) {
          contextParts.push(`\n## 上游任务 #${depId} 的产出\n${depResult.answer}`);
        }
      }

      const roleTools = this.createRoleToolSet(role);
      const result = await runAgentTask(
        {
          provider: this.deps.provider,
          tools: roleTools,
          cwd: this.deps.cwd,
          maxRounds: 10,
          maxRetries: this.deps.maxRetries,
          commandTimeoutMs: this.deps.commandTimeoutMs,
          contextTokenBudget: this.deps.contextTokenBudget,
          longTermFacts: this.deps.longTermFacts,
          systemPromptPrefix: role.systemPrompt,
          roleName: role.name,
          roleAvatar: role.avatar,
          approve: this.deps.approve,
          onAssistantMessage: (message) => {
            emit({
              type: 'subtask_assistant',
              taskId: task.id,
              role: role.name + '(修正)',
              roleAvatar: role.avatar,
              content: message.content,
            });
          },
          onToolCall: (call) => {
            emit({
              type: 'subtask_tool_call',
              taskId: task.id,
              role: role.name + '(修正)',
              name: call.function.name,
              arguments: call.function.arguments,
            });
          },
          onToolResult: (call, toolResult) => {
            emit({
              type: 'subtask_tool_result',
              taskId: task.id,
              role: role.name + '(修正)',
              name: call.function.name,
              ok: toolResult.ok,
              output: toolResult.output,
              error: toolResult.error,
            });
          },
        },
        contextParts.join('\n'),
      );

      const elapsedMs = Date.now() - start;
      const answer = result.answer ?? result.error ?? '(无输出)';

      emit({
        type: 'subtask_done',
        taskId: task.id,
        role: role.name + '(修正)',
        roleAvatar: role.avatar,
        answer,
        elapsedMs,
        status: result.status,
      });

      fixResults.push({
        taskId: task.id,
        role: role.name,
        roleAvatar: role.avatar,
        title: task.title,
        answer,
        elapsedMs,
        status: result.status,
        error: result.error,
      });
    }

    return fixResults;
  }

  /* ==================== 汇总 ==================== */
  private summarize(
    userRequest: string,
    subtasks: SubTask[],
    results: SubTaskResult[],
    reviewText: string,
    reviewScore: number,
  ): string {
    const parts: string[] = [
      `## 任务完成汇总`,
      `\n**原始请求**: ${userRequest}`,
      `\n**拆解**: 共 ${subtasks.length} 个子任务`,
    ];

    for (const r of results) {
      parts.push(`\n---\n### [${r.roleAvatar}] ${r.role} — #${r.taskId}: ${r.title}`);
      parts.push(`耗时: ${(r.elapsedMs / 1000).toFixed(1)}s | 状态: ${r.status === 'completed' ? '✅ 完成' : '⚠️ ' + r.status}`);
      parts.push(`\n${r.answer}`);
    }

    parts.push(`\n---\n### 审查结果`);
    parts.push(`评分: ${reviewScore}/100`);
    if (reviewText) {
      parts.push(`\n${reviewText}`);
    }

    return parts.join('\n');
  }
}
