import fs from 'node:fs';
import path from 'node:path';

export interface Fact {
  id: number;
  createdAt: string;
  fact: string;
  category?: 'preference' | string;
}

/** 长期事实库：JSON Lines 存储一个持久化的用户偏好事实。
 *
 * 仅保存 "用户偏好" 类事实（用户明确要求的习惯、约束、偏好，不是会话内容）。
 * 例如："习惯用中文回答"、"输出要简洁"、"不要写 Python 脚本，优先用内置工具"。
 */
export class FactStore {
  private readonly file: string;

  constructor(workspaceDir: string, subdir = '.forge/memory') {
    const dir = path.join(workspaceDir, subdir);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'facts.jsonl');
    if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, '', 'utf8');
  }

  /** 读取全部事实 */
  list(): Fact[] {
    const raw = fs.readFileSync(this.file, 'utf8').trim();
    if (!raw) return [];
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Fact)
      .sort((a, b) => a.id - b.id);
  }

  /** 新增一条事实 */
  add(fact: string, category = 'preference'): Fact {
    const all = this.list();
    const nextId = all.length > 0 ? all[all.length - 1].id + 1 : 1;
    const f: Fact = {
      id: nextId,
      createdAt: new Date().toISOString(),
      fact,
      category,
    };
    fs.appendFileSync(this.file, JSON.stringify(f) + '\n', 'utf8');
    return f;
  }

  /** 按 id 删除 */
  delete(id: number): boolean {
    const all = this.list();
    const kept = all.filter((f) => f.id !== id);
    if (kept.length === all.length) return false;
    fs.writeFileSync(this.file, kept.map((f) => JSON.stringify(f)).join('\n') + (kept.length ? '\n' : ''), 'utf8');
    return true;
  }

  /** 清空全部 */
  clear(): number {
    const count = this.list().length;
    fs.writeFileSync(this.file, '', 'utf8');
    return count;
  }

  /** 格式化为注入到 system prompt 的文本 */
  formatForPrompt(): string {
    const all = this.list().filter((f) => !f.category || f.category === 'preference');
    if (all.length === 0) return '';
    const lines = all.map((f) => `- ${f.fact}`);
    return ['=== 用户偏好（长期记忆）===', ...lines, ''].join('\n');
  }
}
