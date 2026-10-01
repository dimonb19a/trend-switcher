import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const tests = readdirSync(dir).filter((name) => /^test-.*\.mjs$/u.test(name));
const child = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...tests.map((name) => resolve(dir, name))],
  { stdio: 'inherit', env: { ...process.env, AGENT_TEST: '1' } });
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
