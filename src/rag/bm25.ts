import { promises as fs, existsSync } from 'node:fs';

/* ================================================================
 * Forge RAG · BM25 关键词检索（Okapi BM25）
 *
 * - 纯 TypeScript 实现，无外部依赖
 * - 倒排索引：term → { docId → termFreq }
 * - 标识符拆分：camelCase / snake_case / kebab-case → 子词
 * - 参数：k1=1.5, b=0.75
 * - 持久化到 bm25-index.json
 * ================================================================ */

export interface BM25Doc {
  id: string;      // chunk id
  text: string;
  file: string;
  startLine: number;
  endLine: number;
  symbolName?: string;
}

export interface BM25Result {
  docId: string;
  score: number;
  doc: BM25Doc;
}

export class BM25 {
  private invertedIndex = new Map<string, Map<string, number>>(); // term → docId → tf
  private docLengths = new Map<string, number>(); // docId → length
  private docs = new Map<string, BM25Doc>(); // docId → doc
  private avgDocLength = 0;
  private readonly k1 = 1.5;
  private readonly b = 0.75;

  constructor(private readonly storePath: string) {}

  async load(): Promise<void> {
    if (!existsSync(this.storePath)) return;
    try {
      const raw = await fs.readFile(this.storePath, 'utf8');
      const data = JSON.parse(raw) as {
        invertedIndex: [string, [string, number][]][];
        docLengths: [string, number][];
        docs: [string, BM25Doc][];
        avgDocLength: number;
      };
      this.invertedIndex = new Map(
        data.invertedIndex.map(([term, entries]) => [term, new Map(entries)] as [string, Map<string, number>]),
      );
      this.docLengths = new Map(data.docLengths);
      this.docs = new Map(data.docs);
      this.avgDocLength = data.avgDocLength ?? 0;
    } catch {
      // 损坏文件，忽略
    }
  }

  async save(): Promise<void> {
    const data = {
      invertedIndex: [...this.invertedIndex.entries()].map(([term, m]) => [term, [...m.entries()]] as [string, [string, number][]]),
      docLengths: [...this.docLengths.entries()],
      docs: [...this.docs.entries()],
      avgDocLength: this.avgDocLength,
    };
    await fs.mkdir(require('node:path').dirname(this.storePath), { recursive: true });
    await fs.writeFile(this.storePath, JSON.stringify(data), 'utf8');
  }

  /** 添加文档到索引 */
  addDoc(doc: BM25Doc): void {
    const tokens = this.tokenize(doc.text);
    const docLength = tokens.length;
    this.docLengths.set(doc.id, docLength);
    this.docs.set(doc.id, doc);

    // 统计词频
    const termFreqs = new Map<string, number>();
    for (const token of tokens) {
      termFreqs.set(token, (termFreqs.get(token) ?? 0) + 1);
    }

    // 更新倒排索引
    for (const [term, tf] of termFreqs) {
      if (!this.invertedIndex.has(term)) {
        this.invertedIndex.set(term, new Map());
      }
      this.invertedIndex.get(term)!.set(doc.id, tf);
    }

    // 更新平均文档长度
    const totalLength = [...this.docLengths.values()].reduce((a, b) => a + b, 0);
    this.avgDocLength = totalLength / this.docLengths.size;
  }

  /** 批量添加文档 */
  addDocs(docs: BM25Doc[]): void {
    for (const doc of docs) this.addDoc(doc);
  }

  /** 删除某文件的所有文档 */
  deleteByFile(filePath: string): void {
    const toDelete: string[] = [];
    for (const [docId, doc] of this.docs) {
      if (doc.file === filePath) toDelete.push(docId);
    }
    for (const docId of toDelete) {
      this.docs.delete(docId);
      this.docLengths.delete(docId);
      for (const termMap of this.invertedIndex.values()) {
        termMap.delete(docId);
      }
    }
    // 重新计算平均长度
    if (this.docLengths.size > 0) {
      const total = [...this.docLengths.values()].reduce((a, b) => a + b, 0);
      this.avgDocLength = total / this.docLengths.size;
    } else {
      this.avgDocLength = 0;
    }
  }

  /** 检索 Top-K */
  search(query: string, topK = 20): BM25Result[] {
    const queryTokens = this.tokenize(query);
    if (queryTokens.length === 0 || this.docs.size === 0) return [];

    const scores = new Map<string, number>(); // docId → score

    for (const term of new Set(queryTokens)) {
      const postings = this.invertedIndex.get(term);
      if (!postings || postings.size === 0) continue;

      const idf = Math.log(1 + (this.docs.size - postings.size + 0.5) / (postings.size + 0.5));

      for (const [docId, tf] of postings) {
        const docLength = this.docLengths.get(docId) ?? this.avgDocLength;
        const numerator = tf * (this.k1 + 1);
        const denominator = tf + this.k1 * (1 - this.b + this.b * (docLength / (this.avgDocLength || 1)));
        const score = idf * (numerator / denominator);
        scores.set(docId, (scores.get(docId) ?? 0) + score);
      }
    }

    const results: BM25Result[] = [];
    for (const [docId, score] of scores) {
      const doc = this.docs.get(docId);
      if (doc) {
        results.push({ docId, score, doc });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  /** 分词：标识符拆分 + 小写化 */
  private tokenize(text: string): string[] {
    const tokens: string[] = [];

    // 按非字母数字分割
    const words = text.split(/[^a-zA-Z0-9_\u4e00-\u9fff]+/);

    for (const word of words) {
      if (!word || word.length < 2) continue;

      // 中文 token 直接加入
      if (/[\u4e00-\u9fff]/.test(word)) {
        tokens.push(word.toLowerCase());
        continue;
      }

      // camelCase / PascalCase 拆分
      const subWords = word
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/_/g, ' ')
        .split(/\s+/)
        .filter(Boolean);

      for (const sw of subWords) {
        if (sw.length >= 2) {
          tokens.push(sw.toLowerCase());
        }
      }
    }

    return tokens;
  }

  get size(): number {
    return this.docs.size;
  }

  clear(): void {
    this.invertedIndex.clear();
    this.docLengths.clear();
    this.docs.clear();
    this.avgDocLength = 0;
  }
}
