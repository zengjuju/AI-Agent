import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ChatMessage } from '../llm/types.js';

export interface SessionRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  provider: string;
  model: string;
  messages: ChatMessage[];
  lastAnswer?: string;
}

export class SessionStore {
  constructor(private readonly dir: string) {}

  async save(record: SessionRecord): Promise<string> {
    await fs.mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, `${record.id}.json`);
    await fs.writeFile(file, JSON.stringify(record, null, 2), 'utf8');
    return file;
  }

  async list(): Promise<string[]> {
    await fs.mkdir(this.dir, { recursive: true }).catch(() => undefined);
    const entries = await fs.readdir(this.dir).catch(() => []);
    return entries.filter((name) => name.endsWith('.json')).sort().reverse();
  }
}

export function createSessionId(): string {
  const now = new Date();
  const pad = (value: number, length = 2): string => String(value).padStart(length, '0');
  return [
    'forge',
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('-');
}
