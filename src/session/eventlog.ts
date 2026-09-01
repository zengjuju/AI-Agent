import fs from 'node:fs';
import path from 'node:path';
import { ChatMessage } from '../llm/types.js';

/** 事件类型 */
export type EventType =
  | 'session_start'
  | 'user_message'
  | 'assistant_message'
  | 'tool_call'
  | 'tool_result'
  | 'session_end'
  | 'checkpoint';

export interface LogEvent {
  seq: number;
  ts: string;            // ISO
  sessionId: string;
  type: EventType;
  payload: Record<string, unknown>;
}

/** 事件日志：Append-Only，按 session 分文件，JSON Lines 格式
 *
 * 使用同步写入（appendFileSync）保证：
 * 1. 每次写入立即落盘，断电/崩溃不会丢最近的事件
 * 2. 测试中 close() 后立即可读
 * 3. CLI/HTTP 单次会话的写入量很小（≤ 数百条），同步开销可忽略
 */
export class EventLog {
  private dir: string;
  private currentSessionId?: string;
  private seq = 0;

  constructor(dir: string) {
    this.dir = dir;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  private filePath(sessionId: string): string {
    return path.join(this.dir, `${sessionId}.log`);
  }

  /** 打开一个 session（读取现有 seq 以便追加不重复） */
  open(sessionId: string): void {
    if (this.currentSessionId === sessionId) return;
    this.currentSessionId = sessionId;
    try {
      const existing = fs.readFileSync(this.filePath(sessionId), 'utf8').trim();
      if (existing) {
        const lastLine = existing.split('\n').pop()!;
        const ev = JSON.parse(lastLine) as LogEvent;
        this.seq = ev.seq;
        return;
      }
    } catch { /* file not exists */ }
    this.seq = 0;
  }

  /** 同步写入事件（立即落盘） */
  append(type: EventType, payload: Record<string, unknown>, sessionId?: string): LogEvent {
    const sid = sessionId ?? this.currentSessionId;
    if (!sid) throw new Error('EventLog: no session opened');
    this.open(sid);
    this.seq += 1;
    const event: LogEvent = {
      seq: this.seq,
      ts: new Date().toISOString(),
      sessionId: sid,
      type,
      payload,
    };
    fs.appendFileSync(this.filePath(sid), JSON.stringify(event) + '\n', 'utf8');
    return event;
  }

  /** 读取指定 session 的全部事件 */
  readAll(sessionId: string): LogEvent[] {
    const file = this.filePath(sessionId);
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').trim();
    if (!lines) return [];
    return lines.split('\n').map((l) => JSON.parse(l) as LogEvent);
  }

  /** 把事件日志回放成 ChatMessage[] 序列（入模用） */
  replayToMessages(events: LogEvent[]): ChatMessage[] {
    const messages: ChatMessage[] = [];
    for (const ev of events) {
      switch (ev.type) {
        case 'user_message':
          messages.push({ role: 'user', content: String(ev.payload.content ?? '') });
          break;
        case 'assistant_message': {
          // content: 空字符串也保留（区别于 null），避免丢失 "模型返回了空内容" 的语义
          const rawContent = ev.payload.content;
          const content = rawContent != null ? String(rawContent) : null;
          // tool_calls: 存储时是扁平结构 {id, name, arguments}，回放时转为标准嵌套结构
          const rawCalls = Array.isArray(ev.payload.tool_calls) ? ev.payload.tool_calls : [];
          const calls: ChatMessage['tool_calls'] = rawCalls.map((tc: Record<string, unknown>) => ({
            id: String(tc.id ?? ''),
            type: 'function' as const,
            function: {
              name: String(tc.name ?? (tc.function as Record<string, unknown> | undefined)?.name ?? ''),
              arguments: String(tc.arguments ?? (tc.function as Record<string, unknown> | undefined)?.arguments ?? ''),
            },
          }));
          messages.push({
            role: 'assistant',
            content,
            tool_calls: calls.length > 0 ? calls : undefined,
          });
          break;
        }
        case 'tool_result': {
          const id = String(ev.payload.tool_call_id ?? '');
          const content = String(
            ev.payload.output ?? (ev.payload.error ? `ERROR: ${ev.payload.error}` : ''),
          );
          messages.push({ role: 'tool', tool_call_id: id, content });
          break;
        }
        case 'checkpoint': {
          messages.push({ role: 'system', content: String(ev.payload.summary ?? '') });
          break;
        }
      }
    }
    return messages;
  }

  /** 列出所有 session 文件（按修改时间倒序） */
  listSessionFiles(): { sessionId: string; mtime: number; eventCount: number }[] {
    if (!fs.existsSync(this.dir)) return [];
    const files = fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => {
        const full = path.join(this.dir, f);
        const st = fs.statSync(full);
        const raw = fs.readFileSync(full, 'utf8').trim();
        const count = raw ? raw.split('\n').filter(Boolean).length : 0;
        return { sessionId: f.slice(0, -4), mtime: st.mtimeMs, eventCount: count };
      });
    return files.sort((a, b) => b.mtime - a.mtime);
  }

  /** 删除一个 session 的日志 */
  deleteSession(sessionId: string): boolean {
    const file = this.filePath(sessionId);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      return true;
    }
    return false;
  }

  /** fork：把指定 session 的日志复制为新 sessionId */
  forkSession(srcId: string, newId: string): boolean {
    const src = this.filePath(srcId);
    const dst = this.filePath(newId);
    if (!fs.existsSync(src)) return false;
    fs.copyFileSync(src, dst);
    return true;
  }

  /** 关闭（同步模式下仅清理内存状态） */
  close(): void {
    this.currentSessionId = undefined;
    this.seq = 0;
  }
}

export function createSessionId(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
  const rand = Math.random().toString(36).slice(2, 6);
  return `forge-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(d.getMilliseconds(), 3)}-${rand}`;
}
