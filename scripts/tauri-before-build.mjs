import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const viewDir = join(repoRoot, 'view');
const packageJson = join(viewDir, 'package.json');

if (!existsSync(packageJson)) {
  console.error(`[tauri-before-build] missing ${packageJson}`);
  process.exit(1);
}

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(
  npmCmd,
  ['run', 'build:static', '--prefix', viewDir],
  { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' },
);

process.exit(result.status ?? 1);
