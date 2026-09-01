import { promises as fs } from 'node:fs';
import path from 'node:path';

import { Tool, ToolExecutionContext, ToolResult, defineTool } from './types.js';
import { Embedder } from '../rag/embedder.js';
import { Indexer } from '../rag/indexer.js';

/* ================================================================
 * Forge RAG · retrieve 工具
 *
 * Agentic RAG：Agent 自主决定何时在工作区代码库中按语义检索
 * 返回带 file:line 引用标注的代码片段
 * ================================================================ */

// 模块级单例：按 cwd 缓存 Indexer 实例
const indexerMap = new Map<string, Indexer>();

async function getIndexer(cwd: string): Promise<Indexer> {
  let indexer = indexerMap.get(cwd);
  if (indexer) return indexer;

  // 从 .forge/config.json 读取 API 配置
  const forgeDir = path.join(cwd, '.forge');
  let config: {
    apiKey?: string;
    apiBase?: string;
    model?: string;
    embeddingModel?: string;
    embeddingApiBase?: string;
    embeddingApiKey?: string;
  } = {};
  try {
    const raw = await fs.readFile(path.join(forgeDir, 'config.json'), 'utf8');
    config = JSON.parse(raw);
  } catch {
    // 配置不存在
  }

  // embedding API 配置：优先用独立的 embedding 配置，回退到 chat API 配置
  const embeddingApiKey =
    config.embeddingApiKey ||
    config.apiKey ||
    process.env.FORGE_API_KEY ||
    process.env.PI_API_KEY ||
    process.env.DEEPSEEK_API_KEY ||
    '';
  const embeddingApiBase =
    config.embeddingApiBase ||
    config.apiBase ||
    process.env.FORGE_API_BASE ||
    process.env.PI_API_BASE ||
    process.env.DEEPSEEK_API_BASE ||
    'https://api.openai.com/v1';

  if (!embeddingApiKey) {
    throw new Error('检索功能需要配置 API Key。请在 .forge/config.json 中设置 apiKey 或 embeddingApiKey。');
  }

  const embedder = new Embedder({
    apiKey: embeddingApiKey,
    apiBase: embeddingApiBase,
    model: config.embeddingModel ?? 'text-embedding-3-small',
    timeoutMs: 60_000,
  });

  indexer = new Indexer(cwd, embedder, forgeDir);
  indexerMap.set(cwd, indexer);
  return indexer;
}

export const retrieveTool: Tool = defineTool({
  name: 'retrieve',
  description:
    '在工作区代码库中按语义检索相关代码片段（RAG）。当你需要理解项目结构、查找某个功能的实现、定位某段逻辑、或想找到"跟某个概念相关"的代码时使用。支持自然语言查询，返回带文件路径和行号的代码片段。比 grep 更适合"语义级"搜索。',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '自然语言查询，描述你想找什么代码。例如：用户认证逻辑、错误处理、数据库连接',
      },
      top_k: {
        type: 'number',
        description: '返回结果数，默认 5，上限 10',
      },
    },
    required: ['query'],
  },
  requiresApproval: false,

  async execute(
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    const query = String(args.query ?? '').trim();
    if (!query) {
      return { ok: false, output: '', error: 'query 不能为空' };
    }

    const topK = Math.min(Math.max(Number(args.top_k) || 5, 1), 10);

    try {
      const indexer = await getIndexer(ctx.cwd);
      const results = await indexer.retrieve(query, topK);

      if (results.length === 0) {
        return {
          ok: true,
          output: '未检索到相关代码片段。索引可能尚未建立或工作区无可索引文件。',
        };
      }

      // 格式化输出，带引用标注
      const lines: string[] = [];
      lines.push(`检索到 ${results.length} 个相关代码片段（混合检索：语义+BM25+RRF融合，查询: "${query}"）：`);
      lines.push('');

      // RRF 最大可能分数 = 2/(k+1) = 2/61，归一化到百分比
      const maxRrf = 2 / 61;

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const symbol = r.symbolName ? ` (${r.symbolName})` : '';
        const matchRate = Math.round((r.score / maxRrf) * 100);
        const channels: string[] = [];
        if (r.semanticRank) channels.push(`语义#${r.semanticRank}`);
        if (r.bm25Rank) channels.push(`BM25#${r.bm25Rank}`);
        const channelInfo = channels.length > 0 ? ` [${channels.join(' + ')}]` : '';
        lines.push(`--- 片段 ${i + 1} [${r.file}:${r.startLine}-${r.endLine}]${symbol} 匹配度: ${matchRate}%${channelInfo} ---`);
        lines.push(r.text);
        lines.push('');
      }

      return {
        ok: true,
        output: lines.join('\n'),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        output: '',
        error: `语义检索失败: ${msg}`,
      };
    }
  },
});
