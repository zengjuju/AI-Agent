import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { Chunk, chunkFile, collectFiles } from './chunker.js';
import { Embedder } from './embedder.js';
import { VectorEntry, VectorStore } from './vectorStore.js';
import { BM25, BM25Doc } from './bm25.js';
import { HybridRetriever, HybridResult } from './retriever.js';
import { ChatProvider } from '../llm/types.js';

/* ================================================================
 * Forge RAG · 索引管理器
 *
 * - 启动时扫描工作区，建立/更新索引
 * - 基于 mtime + content-hash 的增量更新
 * - 文件未变更 → 跳过
 * - 新增/修改文件 → 重新分块 + embedding
 * - 删除文件 → 清除对应向量 + BM25
 * - 混合检索：语义 + BM25 + RRF 融合
 * ================================================================ */

export interface IndexStats {
  totalFiles: number;
  indexedFiles: number;
  totalChunks: number;
  lastUpdated: number;
}

interface FileCache {
  [filePath: string]: {
    mtime: number;
    hash: string;
    chunkIds: string[];
  };
}

export class Indexer {
  private vectorStore: VectorStore;
  private bm25: BM25;
  private fileCache: FileCache = {};
  private readonly cachePath: string;
  private readonly storePath: string;
  private readonly bm25Path: string;
  private isIndexed = false;
  private indexingPromise: Promise<void> | null = null;
  private retriever: HybridRetriever | null = null;

  constructor(
    private readonly cwd: string,
    private readonly embedder: Embedder,
    private readonly forgeDir: string,
    private readonly llm?: ChatProvider,
  ) {
    this.storePath = path.join(forgeDir, 'memory', 'vectors.jsonl');
    this.cachePath = path.join(forgeDir, 'memory', 'file-cache.json');
    this.bm25Path = path.join(forgeDir, 'memory', 'bm25-index.json');
    this.vectorStore = new VectorStore(this.storePath);
    this.bm25 = new BM25(this.bm25Path);
  }

  /** 确保索引就绪（懒加载，首次调用时触发） */
  async ensureIndexed(): Promise<void> {
    if (this.isIndexed) return;
    if (this.indexingPromise) {
      await this.indexingPromise;
      return;
    }
    this.indexingPromise = this.reindex();
    await this.indexingPromise;
  }

  /** 全量重建索引 */
  async reindex(): Promise<void> {
    // 1. 加载已有索引
    await this.vectorStore.load();
    await this.bm25.load();
    await this.loadFileCache();

    // 2. 扫描工作区文件
    const files = await collectFiles(this.cwd);
    const cachedFiles = new Set(Object.keys(this.fileCache));
    const currentFiles = new Set(files);

    // 3. 删除已不存在的文件对应向量
    for (const staleFile of cachedFiles) {
      if (!currentFiles.has(staleFile)) {
        this.vectorStore.deleteByFile(staleFile);
        this.bm25.deleteByFile(staleFile);
        delete this.fileCache[staleFile];
      }
    }

    // 4. 增量索引：只处理新增/修改的文件
    const toIndex: string[] = [];
    for (const file of files) {
      const cache = this.fileCache[file];
      if (cache) {
        // 检查 mtime
        try {
          const stat = await fs.stat(path.join(this.cwd, file));
          if (stat.mtimeMs === cache.mtime) continue; // 未变更
        } catch {
          continue; // 文件读取失败，跳过
        }
      }
      toIndex.push(file);
    }

    // 5. 分批处理
    for (const file of toIndex) {
      await this.indexOneFile(file);
    }

    // 6. 持久化
    await this.vectorStore.save();
    await this.bm25.save();
    await this.saveFileCache();
    this.isIndexed = true;
    this.indexingPromise = null;
  }

  /** 索引单个文件 */
  private async indexOneFile(relPath: string): Promise<void> {
    const absPath = path.join(this.cwd, relPath);
    let content: string;
    let stat;
    try {
      content = await fs.readFile(absPath, 'utf8');
      stat = await fs.stat(absPath);
    } catch {
      return; // 文件读取失败，跳过
    }

    const contentHash = hashContent(content);

    // 文件内容未变更（mtime 变了但 hash 一样）
    const cache = this.fileCache[relPath];
    if (cache && cache.hash === contentHash) {
      cache.mtime = stat.mtimeMs; // 更新 mtime
      return;
    }

    // 删除旧向量 + BM25
    this.vectorStore.deleteByFile(relPath);
    this.bm25.deleteByFile(relPath);

    // 分块
    const chunks = chunkFile(relPath, content);
    if (chunks.length === 0) return;

    // embedding
    const texts = chunks.map((c) => c.text);
    const vectors = await this.embedder.embed(texts);

    // 构造 VectorEntry
    const entries: VectorEntry[] = chunks.map((chunk, i) => ({
      id: chunk.id,
      vector: vectors[i],
      text: chunk.text,
      file: chunk.file,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      symbolName: chunk.symbolName,
      lang: chunk.lang,
      hash: chunk.hash,
    }));

    this.vectorStore.insertAll(entries);

    // 同步构建 BM25 索引
    const bm25Docs: BM25Doc[] = chunks.map((c) => ({
      id: c.id,
      text: c.text,
      file: c.file,
      startLine: c.startLine,
      endLine: c.endLine,
      symbolName: c.symbolName,
    }));
    this.bm25.addDocs(bm25Docs);

    // 更新缓存
    this.fileCache[relPath] = {
      mtime: stat.mtimeMs,
      hash: contentHash,
      chunkIds: chunks.map((c) => c.id),
    };
  }

  /** 检索入口（混合检索） */
  async retrieve(
    query: string,
    topK = 5,
    opts?: { rewriteQuery?: boolean; rerank?: boolean },
  ): Promise<HybridResult[]> {
    await this.ensureIndexed();
    const retriever = this.getRetriever();
    return retriever.retrieve(query, topK, opts);
  }

  /** 获取混合检索器 */
  getRetriever(): HybridRetriever {
    if (!this.retriever) {
      this.retriever = new HybridRetriever(
        this.vectorStore,
        this.bm25,
        this.embedder,
        this.llm,
      );
    }
    return this.retriever;
  }

  /** 获取索引统计 */
  getStats(): IndexStats {
    return {
      totalFiles: Object.keys(this.fileCache).length,
      indexedFiles: this.vectorStore.files.size,
      totalChunks: this.vectorStore.size,
      lastUpdated: Date.now(),
    };
  }

  /** 清空全部索引 */
  async clear(): Promise<void> {
    this.vectorStore.clear();
    this.bm25.clear();
    this.fileCache = {};
    await this.vectorStore.save();
    await this.bm25.save();
    await this.saveFileCache();
    this.isIndexed = false;
    this.retriever = null;
  }

  private async loadFileCache(): Promise<void> {
    if (!existsSync(this.cachePath)) {
      this.fileCache = {};
      return;
    }
    try {
      const raw = await fs.readFile(this.cachePath, 'utf8');
      this.fileCache = JSON.parse(raw);
    } catch {
      this.fileCache = {};
    }
  }

  private async saveFileCache(): Promise<void> {
    const dir = path.dirname(this.cachePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.cachePath, JSON.stringify(this.fileCache, null, 2), 'utf8');
  }
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}
