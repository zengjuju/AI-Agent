import { createHash } from 'node:crypto';

/* ================================================================
 * Forge RAG · 向量化器
 *
 * - 调用 OpenAI 兼容的 embedding API（/v1/embeddings）
 * - 批量调用（一次最多 64 条文本）
 * - 基于 content hash 的缓存：相同内容不重复调用 API
 * ================================================================ */

export interface EmbeddingConfig {
  apiKey: string;
  apiBase: string;
  model: string;
  dimensions?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  embedOne(text: string): Promise<number[]>;
}

export class Embedder implements EmbeddingProvider {
  private cache = new Map<string, number[]>();
  private readonly batchSize = 64;
  private readonly timeoutMs: number;

  constructor(private readonly config: EmbeddingConfig) {
    this.timeoutMs = config.timeoutMs ?? 60_000;
  }

  async embedOne(text: string): Promise<number[]> {
    const cached = this.cache.get(hashText(text));
    if (cached) return cached;
    const results = await this.embed([text]);
    this.cache.set(hashText(text), results[0]);
    return results[0];
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    // 分离已缓存和未缓存
    const result: number[][] = new Array(texts.length);
    const toFetch: { index: number; text: string; hash: string }[] = [];

    for (let i = 0; i < texts.length; i++) {
      const h = hashText(texts[i]);
      const cached = this.cache.get(h);
      if (cached) {
        result[i] = cached;
      } else {
        toFetch.push({ index: i, text: texts[i], hash: h });
      }
    }

    if (toFetch.length === 0) return result;

    // 分批调用 API
    for (let batchStart = 0; batchStart < toFetch.length; batchStart += this.batchSize) {
      const batch = toFetch.slice(batchStart, batchStart + this.batchSize);
      const batchTexts = batch.map((b) => b.text.slice(0, 8000)); // API 单条上限

      try {
        const vectors = await this.callEmbeddingApi(batchTexts);
        for (let j = 0; j < batch.length; j++) {
          const vec = vectors[j];
          result[batch[j].index] = vec;
          this.cache.set(batch[j].hash, vec);
        }
      } catch (err) {
        // 单批失败：填零向量（不阻断其他块）
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Embedder] batch failed (${batch.length} texts): ${msg}`);
        for (const b of batch) {
          const zeroVec = new Array(1536).fill(0);
          result[b.index] = zeroVec;
        }
      }
    }

    return result;
  }

  private async callEmbeddingApi(texts: string[]): Promise<number[][]> {
    const base = this.config.apiBase.replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const fetchFn = this.config.fetchImpl ?? fetch;
      const body: Record<string, unknown> = {
        model: this.config.model,
        input: texts,
      };
      if (this.config.dimensions) {
        body.dimensions = this.config.dimensions;
      }

      const res = await fetchFn(`${base}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        let detail = '';
        try { detail = await res.text(); } catch { /* ignore */ }
        throw new Error(`Embedding API ${res.status}: ${detail.slice(0, 300)}`);
      }

      const data = await res.json() as {
        data?: Array<{ embedding?: number[] }>;
      };

      if (!data.data || !Array.isArray(data.data)) {
        throw new Error('Embedding API response missing data array');
      }

      return data.data.map((d) => {
        if (!d.embedding || !Array.isArray(d.embedding)) {
          throw new Error('Embedding API returned invalid embedding');
        }
        return d.embedding;
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** 清除缓存（索引重建时用） */
  clearCache(): void {
    this.cache.clear();
  }
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}
