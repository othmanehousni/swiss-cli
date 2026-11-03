#!/usr/bin/env node
// Builds dist/. Runs on `npm install` in a copy of the repository and when npm installs the
// package straight from GitHub (`npm install -g github:othmanehousni/swiss-cli`).
//
// The second case needs care. npm prepares a git dependency by cloning it and running
// `npm install` in the clone, but on a global install that inner run inherits the outer `-g`:
// it installs nothing into the clone, so TypeScript, @types/node and the dependencies are
// missing and the build fails. When they are missing, install them here as a plain local
// install first, then build.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const nodeTypes = join(root, 'node_modules', '@types', 'node', 'package.json');

function run(command, args, env = process.env) {
  // A shell is only needed for npm.cmd on Windows; the arguments here are all fixed strings.
  const shell = process.platform === 'win32' && command === 'npm';
  const result = spawnSync(command, args, { cwd: root, env, shell, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!existsSync(tsc) || !existsSync(nodeTypes)) {
  // Drop the settings that turn the inner install into a global one.
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^npm_config_(global|location|prefix)$/i.test(key)) delete env[key];
  }
  const args = [
    'install',
    '--global=false',
    '--location=project',
    '--include=dev',
    '--ignore-scripts',
    '--no-save',
    '--no-audit',
    '--no-fund',
  ];
  // npm_execpath points at the npm that is running this script; fall back to npm on PATH.
  const npmCli = process.env.npm_execpath;
  if (npmCli?.endsWith('.js')) run(process.execPath, [npmCli, ...args], env);
  else run('npm', args, env);
}

run(process.execPath, [tsc, '-p', 'tsconfig.build.json']);
