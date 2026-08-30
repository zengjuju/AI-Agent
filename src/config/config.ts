import { promises as fs } from 'node:fs';
import path from 'node:path';

export type ProviderName = 'mock' | 'openai-compatible';

export interface AppConfig {
  provider: ProviderName;
  model: string;
  apiBase?: string;
  apiKey?: string;
  cwd: string;
  maxRounds: number;
  maxRetries: number;
  commandTimeoutMs: number;
  autoApprove: boolean;
  port: number;
  sessionDir: string;
}

export interface CliArgs {
  provider?: string;
  model?: string;
  apiBase?: string;
  cwd?: string;
  maxRounds?: string;
  maxRetries?: string;
  commandTimeoutMs?: string;
  autoApprove?: boolean;
  demo?: boolean;
  serve?: boolean;
  port?: string;
  help?: boolean;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const raw: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg?.startsWith('--')) {
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      raw[key] = next;
      i++;
    } else {
      raw[key] = true;
    }
  }

  const args: CliArgs = {};
  if (raw.help) {
    args.help = true;
  }
  if (raw.demo) {
    args.demo = true;
  }
  if (raw['auto-approve']) {
    args.autoApprove = true;
  }
  if (raw.serve) {
    args.serve = true;
  }

  const stringFlags: Array<[string, keyof CliArgs]> = [
    ['provider', 'provider'],
    ['model', 'model'],
    ['api-base', 'apiBase'],
    ['cwd', 'cwd'],
    ['max-rounds', 'maxRounds'],
    ['max-retries', 'maxRetries'],
    ['command-timeout-ms', 'commandTimeoutMs'],
    ['port', 'port'],
  ];
  for (const [rawKey, target] of stringFlags) {
    const value = raw[rawKey];
    if (typeof value === 'string') {
      (args as Record<string, string | boolean | undefined>)[target] = value;
    }
  }
  return args;
}

/**
 * 读取某个键：优先 FORGE_ 前缀 -> 兼容 PI_ 前缀 -> 兼容 DEEPSEEK_ 前缀
 * （对应用户历史要求：通过 PI_API_KEY / PI_API_BASE / PI_MODEL 配置真实模型通道）
 */
function envPick(forgeKey: string, piKey: string, deepseekKey?: string): string | undefined {
  const v = process.env[forgeKey];
  if (typeof v === 'string' && v.length > 0) return v;
  const pv = process.env[piKey];
  if (typeof pv === 'string' && pv.length > 0) return pv;
  if (deepseekKey) {
    const dv = process.env[deepseekKey];
    if (typeof dv === 'string' && dv.length > 0) return dv;
  }
  return undefined;
}

export async function loadConfig(args: CliArgs): Promise<AppConfig> {
  const startCwd = path.resolve(args.cwd ?? process.env.FORGE_CWD ?? process.cwd());
  let fileConfig: Partial<AppConfig> = {};
  try {
    const raw = await fs.readFile(path.join(startCwd, '.forge', 'config.json'), 'utf8');
    fileConfig = JSON.parse(raw) as Partial<AppConfig>;
  } catch {
    // optional config file
  }

  const envProvider = process.env.FORGE_PROVIDER;
  const envApiKey = envPick('FORGE_API_KEY', 'PI_API_KEY', 'DEEPSEEK_API_KEY');
  const envModel = envPick('FORGE_MODEL', 'PI_MODEL', 'DEEPSEEK_MODEL');
  const envApiBase = envPick('FORGE_API_BASE', 'PI_API_BASE', 'DEEPSEEK_API_BASE');

  const providerRaw =
    args.provider ?? envProvider ?? fileConfig.provider ?? (envApiKey ? 'openai-compatible' : 'mock');
  const provider: ProviderName = providerRaw === 'openai-compatible' ? 'openai-compatible' : 'mock';

  const cwd = path.resolve(
    args.cwd ?? process.env.FORGE_CWD ?? fileConfig.cwd ?? startCwd,
  );
  const apiKey = envApiKey ?? fileConfig.apiKey;
  if (provider === 'openai-compatible' && !apiKey) {
    throw new Error(
      '未检测到可用的 API Key；使用 openai-compatible Provider 请通过环境变量 FORGE_API_KEY（或兼容别名 PI_API_KEY / DEEPSEEK_API_KEY）提供。',
    );
  }

  const modelDefault = envModel && !fileConfig.model ? envModel : 'gpt-4.1-mini';
  const baseDefault = envApiBase && !fileConfig.apiBase ? envApiBase : 'https://api.openai.com/v1';
  const config: AppConfig = {
    provider,
    model: args.model ?? envModel ?? fileConfig.model ?? modelDefault,
    apiBase: args.apiBase ?? envApiBase ?? fileConfig.apiBase ?? baseDefault,
    apiKey,
    cwd,
    maxRounds: toPositiveInt(args.maxRounds ?? process.env.FORGE_MAX_ROUNDS ?? fileConfig.maxRounds, 12),
    maxRetries: toPositiveInt(args.maxRetries ?? process.env.FORGE_MAX_RETRIES ?? fileConfig.maxRetries, 2),
    commandTimeoutMs: toPositiveInt(
      args.commandTimeoutMs ?? process.env.FORGE_COMMAND_TIMEOUT_MS ?? fileConfig.commandTimeoutMs,
      30_000,
    ),
    autoApprove:
      Boolean(args.autoApprove) ||
      toBoolean(process.env.FORGE_AUTO_APPROVE) ||
      Boolean(fileConfig.autoApprove),
    port: toPositiveInt(args.port ?? process.env.FORGE_PORT ?? fileConfig.port, 8787),
    sessionDir: fileConfig.sessionDir ?? '.forge/sessions',
  };

  return config;
}

function toPositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function toBoolean(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true' || value?.toLowerCase() === 'yes';
}
