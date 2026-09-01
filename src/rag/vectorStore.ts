import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';

/* ================================================================
 * Forge RAG · 向量存储
 *
 * - 内存数组存储 + JSONL 持久化（无外部向量库依赖）
 * - 余弦相似度 Top-K 检索
 * - 支持按文件增量删除/插入
 * ================================================================ */

export interface VectorEntry {
  id: string;           // chunk hash
  vector: number[];
  text: string;         // 块原文
  file: string;
  startLine: number;
  endLine: number;
  symbolName?: string;
  lang: string;
  hash: string;
}

export interface SearchResult {
  entry: VectorEntry;
  score: number;        // 相似度分数 0~1
}

export class VectorStore {
  private entries: VectorEntry[] = [];
  private vectorDims = 0;
  private dirty = false;

  constructor(private readonly storePath: string) {}

  /** 从 JSONL 文件加载已有索引 */
  async load(): Promise<void> {
    if (!existsSync(this.storePath)) {
      this.entries = [];
      return;
    }
    try {
      const content = await fs.readFile(this.storePath, 'utf8');
      const lines = content.split('\n').filter((l) => l.trim());
      this.entries = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as VectorEntry;
          if (entry.vector && Array.isArray(entry.vector) && entry.vector.length > 0) {
            this.entries.push(entry);
            if (this.vectorDims === 0) this.vectorDims = entry.vector.length;
          }
        } catch {
          // 跳过损坏行
        }
      }
    } catch {
      this.entries = [];
    }
    this.dirty = false;
  }

  /** 持久化到 JSONL 文件 */
  async save(): Promise<void> {
    if (!this.dirty) return;
    const dir = path.dirname(this.storePath);
    await fs.mkdir(dir, { recursive: true });
    const lines = this.entries.map((e) => JSON.stringify(e));
    await fs.writeFile(this.storePath, lines.join('\n') + '\n', 'utf8');
    this.dirty = false;
  }

  /** 批量插入向量 */
  insertAll(entries: VectorEntry[]): void {
    if (entries.length === 0) return;
    this.entries.push(...entries);
    if (this.vectorDims === 0 && entries[0].vector.length > 0) {
      this.vectorDims = entries[0].vector.length;
    }
    this.dirty = true;
  }

  /** 删除某文件的所有向量（增量更新用） */
  deleteByFile(filePath: string): void {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.file !== filePath);
    if (this.entries.length !== before) this.dirty = true;
  }

  /** 检查某文件是否已被索引 */
  hasFile(filePath: string): boolean {
    return this.entries.some((e) => e.file === filePath);
  }

  /** 获取某文件的块数 */
  getChunkCount(filePath: string): number {
    return this.entries.filter((e) => e.file === filePath).length;
  }

  /** 语义检索：余弦相似度 Top-K */
  search(queryVector: number[], topK = 20): SearchResult[] {
    if (this.entries.length === 0) return [];

    const queryNorm = norm(queryVector);
    if (queryNorm === 0) return [];

    const scores: SearchResult[] = [];
    for (const entry of this.entries) {
      const entryNorm = norm(entry.vector);
      if (entryNorm === 0) continue;
      const sim = dot(queryVector, entry.vector) / (queryNorm * entryNorm);
      scores.push({ entry, score: sim });
    }

    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, topK);
  }

  get size(): number {
    return this.entries.length;
  }

  get files(): Set<string> {
    return new Set(this.entries.map((e) => e.file));
  }

  /** 清空存储 */
  clear(): void {
    this.entries = [];
    this.vectorDims = 0;
    this.dirty = true;
  }
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

function norm(vec: number[]): number {
  let sum = 0;
  for (const v of vec) sum += v * v;
  return Math.sqrt(sum);
}
