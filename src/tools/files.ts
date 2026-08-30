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

function errorResult(error: string): ToolResult {
  return { ok: false, output: '', error };
}
