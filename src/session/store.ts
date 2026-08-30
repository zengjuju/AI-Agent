import { EventLog, LogEvent } from './eventlog.js';

export interface SessionMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  provider: string;
  model: string;
  lastAnswer?: string;
  eventCount: number;
  summary?: string;    // 从日志回放后自动生成的 1 行摘要（最近 user/assistant）
}

/**
 * 会话元信息存储（轻量 JSON）
 * 事件日志是唯一事实源（EventLog），这里只存不易从日志恢复的元信息。
 * 事件日志 + 元信息共同决定会话状态。
 */
import fs from 'node:fs';
import path from 'node:path';

export class SessionStore {
  private readonly metaDir: string;
  readonly eventLog: EventLog;

  constructor(workspaceDir: string, sessionSubdir = '.forge/sessions') {
    const base = path.join(workspaceDir, sessionSubdir);
    this.metaDir = path.join(base, 'meta');
    this.eventLog = new EventLog(path.join(base, 'logs'));
    if (!fs.existsSync(this.metaDir)) fs.mkdirSync(this.metaDir, { recursive: true });
  }

  private metaPath(id: string): string {
    return path.join(this.metaDir, `${id}.json`);
  }

  saveMeta(meta: SessionMeta): string {
    fs.mkdirSync(this.metaDir, { recursive: true });
    const file = this.metaPath(meta.id);
    fs.writeFileSync(file, JSON.stringify(meta, null, 2), 'utf8');
    return file;
  }

  loadMeta(id: string): SessionMeta | null {
    const file = this.metaPath(id);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as SessionMeta;
  }

  /** 列出所有会话（含摘要），时间倒序 */
  list(): SessionMeta[] {
    fs.mkdirSync(this.metaDir, { recursive: true });
    const events = this.eventLog.listSessionFiles();
    return events
      .map(({ sessionId, eventCount, mtime }) => {
        const meta = this.loadMeta(sessionId);
        if (!meta) {
          // 只有日志但无元信息的老会话，也列出来
          return {
            id: sessionId,
            createdAt: new Date(mtime).toISOString(),
            updatedAt: new Date(mtime).toISOString(),
            cwd: '',
            provider: '',
            model: '',
            eventCount,
            summary: this.autoSummary(sessionId),
          };
        }
        return {
          ...meta,
          eventCount,
          updatedAt: new Date(mtime).toISOString(),
          summary: meta.summary ?? this.autoSummary(sessionId),
        };
      })
      .sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1));
  }

  /** 自动生成 1 行摘要：从日志里找最近 user/assistant 内容 */
  autoSummary(sessionId: string): string {
    const events = this.eventLog.readAll(sessionId);
    let lastUser = '';
    let lastAssistant = '';
    for (const ev of events) {
      if (ev.type === 'user_message') lastUser = String(ev.payload.content ?? '');
      if (ev.type === 'assistant_message' && ev.payload.content) {
        lastAssistant = String(ev.payload.content);
      }
    }
    const part = (lastUser || lastAssistant || '').replace(/\s+/g, ' ').trim();
    return part ? part.slice(0, 60) + (part.length > 60 ? '…' : '') : '(空会话)';
  }

  /** 从日志回放得到 ChatMessage[] */
  replayMessages(sessionId: string): import('../llm/types.js').ChatMessage[] {
    const events = this.eventLog.readAll(sessionId);
    return this.eventLog.replayToMessages(events);
  }

  delete(id: string): boolean {
    let ok = this.eventLog.deleteSession(id);
    const mf = this.metaPath(id);
    if (fs.existsSync(mf)) {
      fs.unlinkSync(mf);
      ok = true;
    }
    return ok;
  }

  /** fork：复制日志 + 元信息，返回新 id */
  fork(srcId: string, newId: string): SessionMeta | null {
    if (!this.eventLog.forkSession(srcId, newId)) return null;
    const srcMeta = this.loadMeta(srcId);
    if (srcMeta) {
      const newMeta: SessionMeta = {
        ...srcMeta,
        id: newId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        summary: `(fork from ${srcId}) ${srcMeta.summary ?? ''}`,
      };
      this.saveMeta(newMeta);
      return newMeta;
    }
    return null;
  }
}

// 兼容旧 createSessionId 导出（从 eventlog.ts 导出）
export { createSessionId } from './eventlog.js';
export type { LogEvent };
