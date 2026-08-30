import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { ToolRegistry } from '../src/tools/registry.js';
import { resolveInWorkspace } from '../src/tools/files.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => removeTempDir(dir)));
});

async function tempCwd(): Promise<string> {
  const dir = await makeTempDir();
  tempDirs.push(dir);
  return dir;
}

test('list_dir, write_file and read_file work in workspace', async () => {
  const cwd = await tempCwd();
  const registry = new ToolRegistry();
  const ctx = { cwd, commandTimeoutMs: 10_000, approve: async () => true };

  const listBefore = await registry.run('list_dir', { path: '.' }, ctx);
  assert.equal(listBefore.ok, true);
  assert.match(listBefore.output, /empty directory/);

  const written = await registry.run('write_file', { path: 'sub/hello.txt', content: 'Hello Forge' }, ctx);
  assert.equal(written.ok, true);
  assert.match(written.output, /wrote/);

  const read = await registry.run('read_file', { path: 'sub/hello.txt' }, ctx);
  assert.equal(read.ok, true);
  assert.equal(read.output, 'Hello Forge');

  const listAfter = await registry.run('list_dir', { path: 'sub' }, ctx);
  assert.equal(listAfter.ok, true);
  assert.match(listAfter.output, /hello/);
});

test('run_command executes locally and captures output', async () => {
  const cwd = await tempCwd();
  const registry = new ToolRegistry();
  const result = await registry.run(
    'run_command',
    { command: process.platform === 'win32' ? 'Write-Output forge-agent' : 'echo forge-agent' },
    { cwd, commandTimeoutMs: 10_000, approve: async () => true },
  );
  assert.equal(result.ok, true);
  assert.match(result.output, /forge-agent/);
});

test('approval denial blocks write_file', async () => {
  const cwd = await tempCwd();
  const registry = new ToolRegistry();
  const result = await registry.run(
    'write_file',
    { path: 'blocked.txt', content: 'x' },
    { cwd, commandTimeoutMs: 10_000, approve: async () => false },
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /permission denied/);
  await assert.rejects(fs.stat(path.join(cwd, 'blocked.txt')));
});

test('registry rejects unknown tools and malformed arguments', async () => {
  const cwd = await tempCwd();
  const registry = new ToolRegistry();
  const ctx = { cwd, commandTimeoutMs: 10_000, approve: async () => true };

  const unknown = await registry.run('no_such_tool', {}, ctx);
  assert.equal(unknown.ok, false);
  assert.match(unknown.error ?? '', /unknown tool/);

  const malformed = await registry.run('read_file', '{bad json', ctx);
  assert.equal(malformed.ok, false);
  assert.match(malformed.error ?? '', /invalid JSON/);
});

test('resolveInWorkspace blocks paths outside the workspace', () => {
  const cwd = 'D:\\project';
  assert.throws(() => resolveInWorkspace(cwd, '..\\outside.txt'), /escapes workspace/);
  assert.equal(resolveInWorkspace(cwd, 'sub/file.txt'), 'D:\\project\\sub\\file.txt');
});
