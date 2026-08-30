import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { loadConfig, parseCliArgs } from '../src/config/config.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const tempDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => removeTempDir(dir)));
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  for (const key of Object.keys(savedEnv)) {
    delete savedEnv[key];
  }
});

test('defaults to mock provider without an API key', async () => {
  const cwd = await makeTempDir();
  tempDirs.push(cwd);
  const config = await loadConfig({ cwd });
  assert.equal(config.provider, 'mock');
  assert.equal(config.model, 'gpt-4.1-mini');
  assert.equal(config.maxRounds, 12);
  assert.equal(config.autoApprove, false);
});

test('openai-compatible provider requires FORGE_API_KEY', async () => {
  const cwd = await makeTempDir();
  tempDirs.push(cwd);
  await assert.rejects(
    loadConfig({ cwd, provider: 'openai-compatible' }),
    /FORGE_API_KEY/,
  );
});

test('env API key selects openai-compatible provider', async () => {
  const cwd = await makeTempDir();
  tempDirs.push(cwd);
  savedEnv.FORGE_API_KEY = process.env.FORGE_API_KEY;
  process.env.FORGE_API_KEY = 'sk-test';
  const config = await loadConfig({ cwd });
  assert.equal(config.provider, 'openai-compatible');
  assert.equal(config.apiKey, 'sk-test');
});

test('parseCliArgs handles flags and values', () => {
  assert.deepEqual(
    parseCliArgs(['--demo', '--cwd', 'D:/work', '--max-rounds', '5']),
    { demo: true, cwd: 'D:/work', maxRounds: '5' },
  );
});
