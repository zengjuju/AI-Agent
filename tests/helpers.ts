import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'forge-test-'));
}

export async function removeTempDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}
