import path from 'node:path';

import { Embedder } from './embedder.js';
import { VectorStore, SearchResult } from './vectorStore.js';
import { BM25, BM25Doc, BM25Result } from './bm25.js';
import { ChatProvider, ChatRequest } from '../llm/types.js';

/* ================================================================
 * Forge RAG · 混合检索器
 *
 * - 语义路：query → embedding → 余弦相似度 Top-K
 * - 关键词路：query → BM25 Top-K
 * - RRF 融合：score(d) = 1/(60 + rank_sem) + 1/(60 + rank_bm25)
 * - 可选 Query Rewriting（LLM 改写查询）
 * - 可选 Reranking（LLM 打分）
 * ================================================================ */

export interface HybridResult {
  text: string;
  file: string;
  startLine: number;
  endLine: number;
  symbolName?: string;
  score: number;       // 融合后分数
  semanticRank?: number;
  bm25Rank?: number;
}

export class HybridRetriever {
  constructor(
    private readonly vectorStore: VectorStore,
    private readonly bm25: BM25,
    private readonly embedder: Embedder,
    private readonly llm?: ChatProvider,
  ) {}

  /** 混合检索主入口 */
  async retrieve(
    query: string,
    topK = 5,
    opts?: { rewriteQuery?: boolean; rerank?: boolean },
  ): Promise<HybridResult[]> {
    let searchQuery = query;

    // 1. 查询改写（可选）
    if (opts?.rewriteQuery && this.llm) {
      try {
        searchQuery = await this.rewriteQuery(query);
      } catch {
        searchQuery = query; // 改写失败用原查询
      }
    }

    // 2. 并行检索两路
    const [semanticResults, bm25Results] = await Promise.all([
      this.semanticSearch(searchQuery, 20),
      this.bm25Search(searchQuery, 20),
    ]);

    // 3. RRF 融合
    const fused = this.rrfFuse(semanticResults, bm25Results, 60);

    // 4. Reranking（可选）
    if (opts?.rerank && this.llm && fused.length > topK) {
      const candidates = fused.slice(0, Math.min(topK * 4, 20));
      try {
        const reranked = await this.rerank(query, candidates);
        return reranked.slice(0, topK);
      } catch {
        // rerank 失败，直接用 RRF 结果
      }
    }

    return fused.slice(0, topK);
  }

  /** 语义检索路 */
  private async semanticSearch(query: string, topK: number): Promise<SearchResult[]> {
    const queryVec = await this.embedder.embedOne(query);
    return this.vectorStore.search(queryVec, topK);
  }

  /** BM25 检索路 */
  private async bm25Search(query: string, topK: number): Promise<BM25Result[]> {
    return this.bm25.search(query, topK);
  }

  /** RRF 融合 */
  private rrfFuse(
    semantic: SearchResult[],
    bm25: BM25Result[],
    k: number,
  ): HybridResult[] {
    const scores = new Map<string, HybridResult>();

    // 语义路
    semantic.forEach((r, rank) => {
      const id = r.entry.id;
      const rrfScore = 1 / (k + rank + 1);
      const existing = scores.get(id);
      if (existing) {
        existing.score += rrfScore;
        existing.semanticRank = rank + 1;
      } else {
        scores.set(id, {
          text: r.entry.text,
          file: r.entry.file,
          startLine: r.entry.startLine,
          endLine: r.entry.endLine,
          symbolName: r.entry.symbolName,
          score: rrfScore,
          semanticRank: rank + 1,
        });
      }
    });

    // BM25 路
    bm25.forEach((r, rank) => {
      const id = r.doc.id;
      const rrfScore = 1 / (k + rank + 1);
      const existing = scores.get(id);
      if (existing) {
        existing.score += rrfScore;
        existing.bm25Rank = rank + 1;
      } else {
        scores.set(id, {
          text: r.doc.text,
          file: r.doc.file,
          startLine: r.doc.startLine,
          endLine: r.doc.endLine,
          symbolName: r.doc.symbolName,
          score: rrfScore,
          bm25Rank: rank + 1,
        });
      }
    });

    const results = [...scores.values()];
    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /** LLM 查询改写 */
  private async rewriteQuery(query: string): Promise<string> {
    if (!this.llm) return query;

    const request: ChatRequest = {
      model: this.llm.model,
      temperature: 0,
      maxTokens: 200,
      messages: [
        {
          role: 'system',
          content: '你是查询改写助手。把用户的自然语言查询改写为更适合代码检索的关键词组合。规则：1.保留原意 2.提取核心概念词 3.用空格分隔 4.输出英文关键词优先 5.只输出改写后的查询，不要多余文字',
        },
        { role: 'user', content: query },
      ],
    };

    const res = await this.llm.chat(request);
    return (res.message.content ?? query).trim();
  }

  /** LLM 重排序（RankGPT 风格） */
  private async rerank(query: string, candidates: HybridResult[]): Promise<HybridResult[]> {
    if (!this.llm || candidates.length <= 1) return candidates;

    // 构造打分 prompt
    const docTexts = candidates.map((c, i) => {
      const snippet = c.text.slice(0, 300).replace(/\n/g, ' ');
      return `[${i}] ${c.file}:${c.startLine} ${snippet}`;
    });

    const request: ChatRequest = {
      model: this.llm.model,
      temperature: 0,
      maxTokens: 800,
      messages: [
        {
          role: 'system',
          content:
            '你是代码相关性评估专家。给定用户查询和多个代码片段，给每个片段打 0-10 的相关性分数。' +
            '10 表示完全相关，0 表示完全无关。输出 JSON 数组，格式 [{"index":0,"score":8},...]。只输出 JSON。',
        },
        {
          role: 'user',
          content: `查询: ${query}\n\n代码片段:\n${docTexts.join('\n')}`,
        },
      ],
    };

    const res = await this.llm.chat(request);
    const content = res.message.content ?? '';

    // 解析 JSON
    try {
      // 提取 JSON 数组
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return candidates;

      const scores = JSON.parse(jsonMatch[0]) as Array<{ index: number; score: number }>;
      const scored = candidates.map((c, i) => ({
        ...c,
        rerankScore: scores.find((s) => s.index === i)?.score ?? 5,
      }));
      scored.sort((a, b) => (b.rerankScore ?? 5) - (a.rerankScore ?? 5));
      return scored;
    } catch {
      return candidates;
    }
  }
}
