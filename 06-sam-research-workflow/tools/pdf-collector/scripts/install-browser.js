import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PLAYWRIGHT_BROWSERS_DIR, ROOT } from '../src/constants.js';

const cli = path.join(ROOT, 'node_modules', 'playwright', 'cli.js');
const result = spawnSync(process.execPath, ['--use-system-ca', cli, 'install', 'chromium'], {
  cwd:path.dirname(fileURLToPath(import.meta.url)),
  stdio:'inherit',
  env:{ ...process.env, PLAYWRIGHT_BROWSERS_PATH:PLAYWRIGHT_BROWSERS_DIR },
  shell:false,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
