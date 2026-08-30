import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { createSessionId, SessionRecord, SessionStore } from '../src/session/store.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => removeTempDir(dir)));
});

test('SessionStore saves and lists sessions', async () => {
  const root = await makeTempDir();
  tempDirs.push(root);
  const store = new SessionStore(path.join(root, '.forge', 'sessions'));
  const record: SessionRecord = {
    id: createSessionId(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cwd: root,
    provider: 'mock',
    model: 'forge-mock',
    messages: [{ role: 'user', content: 'hi' }],
    lastAnswer: 'hello',
  };

  const file = await store.save(record);
  assert.ok((await fs.stat(file)).isFile());

  const list = await store.list();
  assert.equal(list.length, 1);
  assert.match(list[0] ?? '', /\.json$/);
});
