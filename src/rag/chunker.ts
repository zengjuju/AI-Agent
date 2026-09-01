import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/* ================================================================
 * Forge RAG · 代码分块器
 *
 * 策略：
 * - .ts/.js/.tsx/.jsx → TypeScript Compiler API AST 分块（按函数/类/接口边界）
 * - .py → 按 def/class 缩进边界切分
 * - .md/.txt/.json → 递归字符分块（~1200 token，100 overlap）
 * - 其他文本 → 递归字符分块
 *
 * 每个块附带元数据：file, startLine, endLine, symbolName, lang, hash
 * ================================================================ */

export interface Chunk {
  id: string;
  text: string;
  file: string;
  startLine: number;
  endLine: number;
  symbolName?: string;
  lang: string;
  hash: string;
}

const MAX_CHUNK_TOKENS = 1200;
const OVERLAP_TOKENS = 100;
const SUPPORTED_CODE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const SUPPORTED_PY = new Set(['.py']);
const SUPPORTED_DOC = new Set(['.md', '.txt', '.markdown', '.rst']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.forge', '.next', 'build']);

/** 估算 token 数（与 context.ts 保持一致） */
function estTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
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

function makeHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function langFromExt(ext: string): string {
  if (SUPPORTED_CODE.has(ext)) return 'typescript';
  if (SUPPORTED_PY.has(ext)) return 'python';
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  return 'text';
}

/** 递归字符分块（文档用） */
function recursiveChunk(
  text: string,
  file: string,
  lang: string,
): Chunk[] {
  const lines = text.split('\n');
  const chunks: Chunk[] = [];
  let current = '';
  let startLine = 1;
  let currentTokens = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineTokens = estTokens(line + '\n');

    if (currentTokens + lineTokens > MAX_CHUNK_TOKENS && current.trim()) {
      // 完成当前块
      chunks.push({
        id: makeHash(current),
        text: current.trim(),
        file,
        startLine,
        endLine: i,
        lang,
        hash: makeHash(current),
      });
      // overlap：保留尾部
      const overlapLines = current.split('\n').slice(-Math.ceil(OVERLAP_TOKENS / 4));
      current = overlapLines.join('\n') + '\n';
      currentTokens = estTokens(current);
      startLine = i - overlapLines.length + 1;
    }

    current += line + '\n';
    currentTokens += lineTokens;
  }

  if (current.trim()) {
    chunks.push({
      id: makeHash(current),
      text: current.trim(),
      file,
      startLine,
      endLine: lines.length,
      lang,
      hash: makeHash(current),
    });
  }

  return chunks;
}

/** TypeScript AST 分块：按函数/类/接口边界切分 */
function tsAstChunk(
  code: string,
  file: string,
): Chunk[] {
  const chunks: Chunk[] = [];
  // 动态导入 TypeScript（可能未安装，此时降级到递归分块）
  let ts: typeof import('typescript');
  try {
    ts = require('typescript');
  } catch {
    return recursiveChunk(code, file, 'typescript');
  }
  if (!ts) return recursiveChunk(code, file, 'typescript');

  const sourceFile = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = code.split('\n');

  interface NodeInfo {
    name: string;
    start: number;
    end: number;
    lineStart: number;
    lineEnd: number;
  }
  const nodes: NodeInfo[] = [];

  function visit(node: import('typescript').Node) {
    let name: string | undefined;
    let isTarget = false;

    if (ts.isFunctionDeclaration(node)) {
      name = node.name?.text ?? '(anonymous function)';
      isTarget = true;
    } else if (ts.isClassDeclaration(node)) {
      name = node.name?.text ?? '(anonymous class)';
      isTarget = true;
    } else if (ts.isInterfaceDeclaration(node)) {
      name = node.name?.text;
      isTarget = true;
    } else if (ts.isMethodDeclaration(node)) {
      const parent = node.parent;
      if (parent && ts.isClassDeclaration(parent) && parent.name) {
        name = `${parent.name.text}.${node.name.getText(sourceFile)}`;
        isTarget = true;
      }
    } else if (ts.isEnumDeclaration(node)) {
      name = node.name?.text;
      isTarget = true;
    } else if (ts.isVariableDeclaration(node) && node.initializer) {
      // 大型导出常量（如配置对象）
      const init = node.initializer;
      if (ts.isObjectLiteralExpression(init) && init.properties.length > 3) {
        name = node.name.getText(sourceFile);
        isTarget = true;
      }
    }

    if (isTarget && name) {
      const start = node.getStart(sourceFile);
      const end = node.getEnd();
      nodes.push({
        name,
        start,
        end,
        lineStart: sourceFile.getLineAndCharacterOfPosition(start).line + 1,
        lineEnd: sourceFile.getLineAndCharacterOfPosition(end).line + 1,
      });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  // 没有找到任何 AST 节点 → 整文件作为一个块
  if (nodes.length === 0) {
    return recursiveChunk(code, file, 'typescript');
  }

  // 按位置排序，提取每个节点对应的文本
  nodes.sort((a, b) => a.start - b.start);

  let lastEnd = 0;
  for (const node of nodes) {
    // 节点之间的间隙（import、全局变量等）作为一个块
    if (node.start > lastEnd) {
      const gapText = code.slice(lastEnd, node.start).trim();
      if (gapText && estTokens(gapText) > 20) {
        const gapStart = sourceFile.getLineAndCharacterOfPosition(lastEnd).line + 1;
        const gapEnd = sourceFile.getLineAndCharacterOfPosition(node.start).line + 1;
        chunks.push({
          id: makeHash(gapText),
          text: gapText,
          file,
          startLine: gapStart,
          endLine: gapEnd,
          symbolName: '(module scope)',
          lang: 'typescript',
          hash: makeHash(gapText),
        });
      }
    }

    let nodeText = code.slice(node.start, node.end);
    // 超长的节点做递归切分
    if (estTokens(nodeText) > MAX_CHUNK_TOKENS * 1.5) {
      const subChunks = recursiveChunk(nodeText, file, 'typescript');
      for (const sc of subChunks) {
        chunks.push({
          ...sc,
          startLine: node.lineStart + sc.startLine - 1,
          endLine: node.lineStart + sc.endLine - 1,
          symbolName: node.name,
        });
      }
    } else {
      chunks.push({
        id: makeHash(nodeText),
        text: nodeText,
        file,
        startLine: node.lineStart,
        endLine: node.lineEnd,
        symbolName: node.name,
        lang: 'typescript',
        hash: makeHash(nodeText),
      });
    }

    lastEnd = node.end;
  }

  // 文件尾部
  if (lastEnd < code.length) {
    const tailText = code.slice(lastEnd).trim();
    if (tailText && estTokens(tailText) > 20) {
      const tailStart = sourceFile.getLineAndCharacterOfPosition(lastEnd).line + 1;
      chunks.push({
        id: makeHash(tailText),
        text: tailText,
        file,
        startLine: tailStart,
        endLine: lines.length,
        symbolName: '(tail)',
        lang: 'typescript',
        hash: makeHash(tailText),
      });
    }
  }

  return chunks;
}

/** Python 分块：按 def/class 边界 */
function pythonChunk(
  code: string,
  file: string,
): Chunk[] {
  const lines = code.split('\n');
  const chunks: Chunk[] = [];
  let currentStart = 0;
  let currentName = '(module)';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const defMatch = line.match(/^(async\s+)?def\s+(\w+)\s*\(/);
    const classMatch = line.match(/^class\s+(\w+)\s*[\(:]/);

    if (defMatch || classMatch) {
      // 完成上一个块
      if (i > currentStart) {
        const text = lines.slice(currentStart, i).join('\n').trim();
        if (text && estTokens(text) > 20) {
          chunks.push({
            id: makeHash(text),
            text,
            file,
            startLine: currentStart + 1,
            endLine: i,
            symbolName: currentName,
            lang: 'python',
            hash: makeHash(text),
          });
        }
      }
      currentStart = i;
      currentName = defMatch ? defMatch[2] : classMatch![1];
    }
  }

  // 最后一个块
  if (currentStart < lines.length) {
    const text = lines.slice(currentStart).join('\n').trim();
    if (text && estTokens(text) > 20) {
      chunks.push({
        id: makeHash(text),
        text,
        file,
        startLine: currentStart + 1,
        endLine: lines.length,
        symbolName: currentName,
        lang: 'python',
        hash: makeHash(text),
      });
    }
  }

  return chunks.length > 0 ? chunks : recursiveChunk(code, file, 'python');
}

/** 主入口：分块一个文件 */
export function chunkFile(filePath: string, content: string): Chunk[] {
  const ext = path.extname(filePath).toLowerCase();

  if (SUPPORTED_CODE.has(ext)) {
    return tsAstChunk(content, filePath);
  }
  if (SUPPORTED_PY.has(ext)) {
    return pythonChunk(content, filePath);
  }
  const lang = langFromExt(ext);
  return recursiveChunk(content, filePath, lang);
}

/** 扫描工作区，收集可索引的文件列表 */
export async function collectFiles(
  rootDir: string,
  maxFiles = 500,
): Promise<string[]> {
  const results: string[] = [];
  const exts = new Set([...SUPPORTED_CODE, ...SUPPORTED_PY, ...SUPPORTED_DOC, new Set(['.json'])]);

  async function walk(dir: string) {
    if (results.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      if (SKIP_DIRS.has(entry.name)) continue;
      // 跳过隐藏文件
      if (entry.name.startsWith('.') && entry.name !== '.forge') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (exts.has(ext)) {
          results.push(path.relative(rootDir, full).replace(/\\/g, '/'));
        }
      }
    }
  }

  await walk(rootDir);
  return results.sort();
}
