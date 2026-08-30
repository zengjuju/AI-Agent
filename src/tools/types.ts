import { ToolDefinition } from '../llm/types.js';

export interface ToolResult {
  ok: boolean;
  output: string;
  error?: string;
}

export interface ToolExecutionContext {
  cwd: string;
  commandTimeoutMs?: number;
  approve: (toolName: string, args: Record<string, unknown>) => Promise<boolean>;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  requiresApproval: boolean;
  execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult>;
  definition(): ToolDefinition;
}

export function defineTool(tool: Omit<Tool, 'definition'>): Tool {
  return {
    ...tool,
    definition: (): ToolDefinition => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }),
  };
}
