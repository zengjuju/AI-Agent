import { FactStore } from '../memory/factStore.js';
import { defineTool, ToolExecutionContext, ToolResult } from './types.js';

/**
 * memory 工具：管理用户偏好（长期记忆）。
 * 此工具不需要审批（它本质是笔记工具，不执行外部操作）。
 *
 * 暴露 3 个子命令：
 *   save(fact: string)     → 存一条偏好事实
 *   list()                 → 返回所有偏好事实
 *   forget(id: number)     → 删除一条
 */
export function buildMemoryTool(store: FactStore) {
  return defineTool({
    name: 'memory',
    description:
      '管理用户的长期偏好记忆。用这个工具记录用户明确说过的习惯/约束/偏好（例如"用中文回答"、"输出简洁"、"不要写 Python"），以后的每轮对话都会自动注入给模型，避免用户重复说。只能记录用户偏好类事实，不要记录临时的任务内容或会话中间结论。',
    parameters: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['save', 'list', 'forget'],
          description: '操作类型：save 保存一条；list 列出全部；forget 删除指定 id。',
        },
        fact: {
          type: 'string',
          description: '(op=save 时必填) 一条偏好事实。用简洁中文或英文描述，例如"习惯用中文回答"。',
        },
        id: {
          type: 'integer',
          description: '(op=forget 时必填) 要删除的事实 id。',
        },
      },
      required: ['op'],
      additionalProperties: false,
    },
    requiresApproval: false,
    async execute(args, _ctx?: ToolExecutionContext): Promise<ToolResult> {
      const op = String(args.op);
      try {
        switch (op) {
          case 'save': {
            const fact = String(args.fact ?? '').trim();
            if (!fact) return { ok: false, output: '', error: 'fact 不能为空' };
            const f = store.add(fact, 'preference');
            return {
              ok: true,
              output: `已保存用户偏好 #${f.id}：${f.fact}\n当前共 ${store.list().length} 条偏好。`,
            };
          }
          case 'list': {
            const all = store.list();
            if (all.length === 0) return { ok: true, output: '(还没有任何用户偏好记录)' };
            return {
              ok: true,
              output: all.map((f) => `#${f.id} ${f.fact}`).join('\n'),
            };
          }
          case 'forget': {
            const id = Number(args.id);
            if (!Number.isInteger(id) || id <= 0) {
              return { ok: false, output: '', error: 'id 必须是正整数' };
            }
            const ok = store.delete(id);
            return ok
              ? { ok: true, output: `已删除用户偏好 #${id}` }
              : { ok: false, output: '', error: `不存在 id=${id} 的事实` };
          }
          default:
            return { ok: false, output: '', error: `未知 op：${op}` };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, output: '', error: msg };
      }
    },
  });
}
