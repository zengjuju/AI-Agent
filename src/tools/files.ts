import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Tool, ToolExecutionContext, ToolResult, defineTool } from './types.js';

const MAX_READ_BYTES = 200_000;

export function resolveInWorkspace(cwd: string, input: string): string {
  const root = path.resolve(cwd);
  const resolved = path.resolve(root, input);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`path "${input}" escapes workspace root "${root}"`);
  }
  return resolved;
}

export const listDirTool: Tool = defineTool({
  name: 'list_dir',
  description: 'List entries in a directory inside the workspace.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path relative to the workspace root (default ".").' },
    },
    required: [],
    additionalProperties: false,
  },
  requiresApproval: false,
  async execute(args, ctx) {
    const target = resolveInWorkspace(ctx.cwd, String(args.path ?? '.'));
    const stat = await fs.stat(target).catch(() => null);
    if (!stat) {
      return errorResult(`path does not exist: ${target}`);
    }
    if (!stat.isDirectory()) {
      return errorResult(`not a directory: ${target}`);
    }
    const entries = await fs.readdir(target, { withFileTypes: true });
    const lines = entries
      .map((entry) => `${entry.isDirectory() ? '[dir] ' : '[file]'} ${entry.name}`)
      .sort((a, b) => a.localeCompare(b));
    return { ok: true, output: lines.length > 0 ? lines.join('\n') : '(empty directory)' };
  },
});

export const readFileTool: Tool = defineTool({
  name: 'read_file',
  description: 'Read a UTF-8 text file inside the workspace.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the workspace root.' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  requiresApproval: false,
  async execute(args, ctx) {
    const target = resolveInWorkspace(ctx.cwd, String(args.path));
    const stat = await fs.stat(target).catch(() => null);
    if (!stat || !stat.isFile()) {
      return errorResult(`not a readable file: ${target}`);
    }
    if (stat.size > MAX_READ_BYTES) {
      return errorResult(`file too large to read (${stat.size} bytes > ${MAX_READ_BYTES} bytes)`);
    }
    const content = await fs.readFile(target, 'utf8');
    return { ok: true, output: content };
  },
});

export const writeFileTool: Tool = defineTool({
  name: 'write_file',
  description: 'Create or overwrite a UTF-8 text file inside the workspace. Requires user approval.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the workspace root.' },
      content: { type: 'string', description: 'File content to write.' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  requiresApproval: true,
  async execute(args, ctx) {
    const target = resolveInWorkspace(ctx.cwd, String(args.path));
    const content = String(args.content ?? '');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
    return { ok: true, output: `wrote ${target} (${Buffer.byteLength(content, 'utf8')} bytes)` };
  },
});

export const runCommandTool: Tool = defineTool({
  name: 'run_command',
  description: 'Run a shell command in the workspace directory. Requires user approval.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to run.' },
      timeoutMs: { type: 'integer', description: 'Optional timeout in milliseconds.' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  requiresApproval: true,
  async execute(args, ctx: ToolExecutionContext) {
    const command = String(args.command);
    const requestedTimeout = Number(args.timeoutMs ?? NaN);
    const timeoutMs =
      Number.isInteger(requestedTimeout) && requestedTimeout > 0
        ? requestedTimeout
        : (ctx.commandTimeoutMs ?? 30_000);
    const isWindows = process.platform === 'win32';

    return new Promise<ToolResult>((resolve) => {
      const child = isWindows
        ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
            cwd: ctx.cwd,
            windowsHide: true,
          })
        : spawn(command, { cwd: ctx.cwd, shell: true });

      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        resolve({ ok: false, output: '', error: `command timed out after ${timeoutMs}ms` });
      }, timeoutMs);

      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, output: '', error: err.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
        if (code === 0) {
          resolve({ ok: true, output: output || '(command completed with no output)' });
        } else {
          resolve({ ok: false, output: output, error: `exit code ${code}` });
        }
      });
    });
  },
});

export const editFileTool: Tool = defineTool({
  name: 'edit_file',
  description:
    '对工作区内已有文件做增量补丁替换。传入 old_string（文件中必须精确存在的片段）和 new_string（替换后的内容）。如果 old_string 在文件中找不到或不唯一，会返回错误提示。比 write_file 更安全——只改局部，不会覆盖整个文件。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（相对于工作区根目录）。' },
      old_string: { type: 'string', description: '要被替换的原始文本片段（必须与文件内容精确匹配，包括缩进和换行）。' },
      new_string: { type: 'string', description: '替换后的新文本片段。' },
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  requiresApproval: true,
  async execute(args, ctx) {
    const target = resolveInWorkspace(ctx.cwd, String(args.path));
    const oldStr = String(args.old_string);
    const newStr = String(args.new_string);

    const stat = await fs.stat(target).catch(() => null);
    if (!stat || !stat.isFile()) {
      return errorResult(`文件不存在或不可读: ${target}`);
    }

    const content = await fs.readFile(target, 'utf8');

    // 检查 old_string 是否存在
    const occurrences = content.split(oldStr).length - 1;
    if (occurrences === 0) {
      // 提供上下文提示帮助模型修正
      const lines = content.split('\n');
      return errorResult(
        `old_string 在文件中未找到。文件共 ${lines.length} 行。请先用 read_file 查看文件内容，确保 old_string 精确匹配（包括缩进和换行）。`,
      );
    }
    if (occurrences > 1) {
      return errorResult(
        `old_string 在文件中出现了 ${occurrences} 次，无法唯一定位。请提供更长、更精确的 old_string 上下文以唯一匹配。`,
      );
    }

    const newContent = content.replace(oldStr, newStr);
    await fs.writeFile(target, newContent, 'utf8');
    return {
      ok: true,
      output: `已替换 ${target} 中的 ${oldStr.length} 字符 → ${newStr.length} 字符（文件总计 ${newContent.length} 字符）`,
    };
  },
});

export const readFilePagedTool: Tool = defineTool({
  name: 'read_file_paged',
  description:
    '分页读取大文件。支持 start_line 和 end_line 参数按行号读取指定范围，适合大文件分段查看。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（相对于工作区根目录）。' },
      start_line: { type: 'integer', description: '起始行号（从 1 开始，默认 1）。' },
      end_line: { type: 'integer', description: '结束行号（默认到文件末尾）。' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  requiresApproval: false,
  async execute(args, ctx) {
    const target = resolveInWorkspace(ctx.cwd, String(args.path));
    const stat = await fs.stat(target).catch(() => null);
    if (!stat || !stat.isFile()) {
      return errorResult(`不是可读文件: ${target}`);
    }
    const raw = await fs.readFile(target, 'utf8');
    const lines = raw.split('\n');
    const start = Math.max(1, Number(args.start_line ?? 1));
    const end = Math.min(lines.length, Number(args.end_line ?? lines.length));
    const sliced = lines.slice(start - 1, end);
    const numbered = sliced.map((line, i) => `${start + i}→${line}`).join('\n');
    return {
      ok: true,
      output: `文件 ${args.path}（共 ${lines.length} 行，显示 ${start}-${end}）:\n${numbered}`,
    };
  },
});

function errorResult(error: string): ToolResult {
  return { ok: false, output: '', error };
}
