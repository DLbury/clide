#!/usr/bin/env node
/**
 * Package a Windows portable (no-install) zip from a release build output.
 * Run after `tauri build` on windows-latest CI (or locally on Windows).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const conf = JSON.parse(
  fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'),
);
const version = conf.version;
const productName = conf.productName;
const releaseDir = path.join(root, 'src-tauri/target/release');
const exeName = 'clide.exe';
const exePath = path.join(releaseDir, exeName);

if (!fs.existsSync(exePath)) {
  console.error(`Missing release binary: ${exePath}`);
  process.exit(1);
}

const staging = path.join(releaseDir, 'portable-staging');
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });

fs.copyFileSync(exePath, path.join(staging, exeName));

const resourcesSrc = path.join(releaseDir, 'resources');
if (fs.existsSync(resourcesSrc)) {
  fs.cpSync(resourcesSrc, path.join(staging, 'resources'), { recursive: true });
}

for (const name of fs.readdirSync(releaseDir)) {
  if (name.endsWith('.dll')) {
    fs.copyFileSync(path.join(releaseDir, name), path.join(staging, name));
  }
}

const readme = `# ${productName} ${version} Portable (Windows x64)

解压后双击 clide.exe 即可运行，无需安装。

注意：需要本机已安装 Microsoft Edge WebView2 运行时（Windows 10/11 通常已自带）。
`;
fs.writeFileSync(path.join(staging, 'README.txt'), readme, 'utf8');

const bundleDir = path.join(releaseDir, 'bundle');
fs.mkdirSync(bundleDir, { recursive: true });
const zipName = `${productName}_${version}_x64-portable.zip`;
const zipPath = path.join(bundleDir, zipName);

fs.rmSync(zipPath, { force: true });

if (process.platform === 'win32') {
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${staging}\\*' -DestinationPath '${zipPath}' -Force"`,
    { stdio: 'inherit' },
  );
} else {
  execSync(`cd "${staging}" && zip -r "${zipPath}" .`, {
    stdio: 'inherit',
    shell: true,
  });
}

console.log(`Created ${zipPath}`);
