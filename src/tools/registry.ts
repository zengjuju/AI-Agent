import { ToolDefinition } from '../llm/types.js';
import { listDirTool, readFileTool, runCommandTool, writeFileTool } from './files.js';
import { fetchUrlTool, searchNewsTool } from './web.js';
import { Tool, ToolExecutionContext, ToolResult } from './types.js';
import { validateArgs } from './validate.js';

export const defaultTools: Tool[] = [listDirTool, readFileTool, writeFileTool, runCommandTool, fetchUrlTool, searchNewsTool];

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(tools: Tool[] = defaultTools) {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition());
  }

  async run(name: string, rawArgs: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, output: '', error: `unknown tool: ${name}` };
    }

    let args: Record<string, unknown>;
    if (typeof rawArgs === 'string') {
      try {
        const parsed = JSON.parse(rawArgs) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return { ok: false, output: '', error: `arguments for ${name} must be a JSON object` };
        }
        args = parsed as Record<string, unknown>;
      } catch {
        return { ok: false, output: '', error: `invalid JSON arguments for ${name}` };
      }
    } else if (typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs)) {
      args = rawArgs as Record<string, unknown>;
    } else {
      return { ok: false, output: '', error: `arguments for ${name} must be a JSON object` };
    }

    const validation = validateArgs(args, tool.parameters);
    if (!validation.ok) {
      return { ok: false, output: '', error: `invalid arguments for ${name}: ${validation.error}` };
    }

    if (tool.requiresApproval) {
      let allowed = false;
      try {
        allowed = await ctx.approve(name, validation.value);
      } catch {
        allowed = false;
      }
      if (!allowed) {
        return { ok: false, output: '', error: `permission denied by user for tool ${name}` };
      }
    }

    try {
      return await tool.execute(validation.value, ctx);
    } catch (err) {
      return { ok: false, output: '', error: err instanceof Error ? err.message : String(err) };
    }
  }
}
