import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Tool, ToolExecutionContext, ToolResult, defineTool } from './types.js';
import { resolveInWorkspace } from './files.js';

/* ================================================================
 * glob: 按文件名模式搜索（只读、无需审批）
 * 支持 * ** ? 通配符，返回匹配的文件路径列表
 * ================================================================ */

// 将 glob 模式转为正则表达式
function globToRegex(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      // ** 匹配任意层级目录 / * 匹配非分隔符
      if (pattern[i + 1] === '*') {
        re += '.*';
        i += 2;
        // 跳过后面的 /
        if (pattern[i] === '/') i++;
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (ch === '?') {
      re += '[^/]';
      i++;
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      re += '\\' + ch;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  return new RegExp('^' + re + '$');
}

async function walkDir(
  dir: string,
  root: string,
  results: string[],
  maxResults: number,
): Promise<void> {
  if (results.length >= maxResults) return;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (results.length >= maxResults) return;
    // 跳过 node_modules / .git / dist
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(root, fullPath).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      await walkDir(fullPath, root, results, maxResults);
    } else {
      results.push(relPath);
    }
  }
}

export const globTool: Tool = defineTool({
  name: 'glob',
  description:
    '按文件名模式搜索工作区内的文件。支持通配符：* 匹配文件名（不含/）、** 匹配任意层级目录、? 匹配单个字符。例如 "src/**/*.ts" 匹配 src 下所有 .ts 文件。只读、不需要审批。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '文件名匹配模式，如 "src/**/*.ts"、"**/*.py"、"*.md"' },
      max_results: {
        type: 'integer',
        description: '最多返回结果数，默认 100，上限 500。',
      },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  requiresApproval: false,
  async execute(args, ctx) {
    const pattern = String(args.pattern);
    const maxResults = typeof args.max_results === 'number' && args.max_results > 0 ? Math.min(args.max_results, 500) : 100;
    const root = path.resolve(ctx.cwd);
    const regex = globToRegex(pattern);

    const results: string[] = [];
    await walkDir(root, root, results, maxResults);

    const matched = results.filter((f) => regex.test(f));

    if (matched.length === 0) {
      return {
        ok: true,
        output: `模式 "${pattern}" 未匹配到任何文件。工作区共扫描 ${results.length} 个文件。`,
      };
    }

    return {
      ok: true,
      output: `模式 "${pattern}" 匹配到 ${matched.length} 个文件（共扫描 ${results.length} 个）:\n${matched.join('\n')}`,
    };
  },
});

/* ================================================================
 * grep: 按内容搜索文件（只读、无需审批）
 * 返回匹配行 + 行号
 * ================================================================ */

export const grepTool: Tool = defineTool({
  name: 'grep',
  description:
    '在工作区内按正则表达式搜索文件内容。返回匹配行和行号。只读、不需要审批。比 run_command("grep -r ...") 更安全且不触发审批。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式搜索模式，如 "import.*Config"、"function\\s+\\w+"' },
      path: { type: 'string', description: '搜索范围（相对于工作区根目录的子目录，默认 "."搜索全部）' },
      include: { type: 'string', description: '文件名过滤，如 "*.ts" 只搜索 .ts 文件' },
      max_results: {
        type: 'integer',
        description: '最多返回匹配行数，默认 50，上限 200。',
      },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  requiresApproval: false,
  async execute(args, ctx) {
    const patternStr = String(args.pattern);
    const searchPath = String(args.path ?? '.');
    const include = args.include ? String(args.include) : undefined;
    const maxResults = typeof args.max_results === 'number' && args.max_results > 0 ? Math.min(args.max_results, 200) : 50;

    let regex: RegExp;
    try {
      regex = new RegExp(patternStr, 'i');
    } catch (err) {
      return { ok: false, output: '', error: `无效的正则表达式: ${err instanceof Error ? err.message : String(err)}` };
    }

    // include 转 glob 正则
    let includeRegex: RegExp | null = null;
    if (include) {
      includeRegex = globToRegex(include);
    }

    const root = resolveInWorkspace(ctx.cwd, searchPath);
    const allFiles: string[] = [];
    await walkDir(root, root, allFiles, 1000);

    const targetFiles = includeRegex ? allFiles.filter((f) => includeRegex.test(path.basename(f))) : allFiles;

    const matches: { file: string; line: number; text: string }[] = [];
    for (const file of targetFiles) {
      if (matches.length >= maxResults) break;
      const fullPath = path.join(root, file);
      const content = await fs.readFile(fullPath, 'utf8').catch(() => '');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= maxResults) break;
        if (regex.test(lines[i])) {
          matches.push({ file, line: i + 1, text: lines[i].trim() });
        }
      }
    }

    if (matches.length === 0) {
      return {
        ok: true,
        output: `在 ${targetFiles.length} 个文件中未找到匹配 "${patternStr}" 的内容。`,
      };
    }

    const output = matches
      .map((m) => `${m.file}:${m.line}: ${m.text}`)
      .join('\n');

    return {
      ok: true,
      output: `在 ${targetFiles.length} 个文件中找到 ${matches.length} 处匹配:\n${output}`,
    };
  },
});
