/**
 * Temp-directory installation service.
 *
 * Clones / copies into a temporary staging directory first,
 * then atomically moves to the final install path on success.
 * This prevents half-installed packages from polluting the
 * imports directory on validation failures.
 */

import { existsSync, rmSync, cpSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { getTempPath } from './path.service.js';

function cloneRepo(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['clone', '--depth', '1', url, destPath];
    const proc = spawn('git', args, { stdio: 'pipe' });

    let stderr = '';
    if (proc.stderr) {
      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
    }

    proc.on('close', (code: number | null) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`git clone failed with code ${code}: ${stderr}`));
      }
    });

    proc.on('error', (err: Error) => {
      reject(new Error(`Failed to run git: ${err.message}`));
    });
  });
}

function removeGitDir(dirPath: string): void {
  const gitDir = join(dirPath, '.git');
  if (existsSync(gitDir)) {
    rmSync(gitDir, { recursive: true, force: true });
  }
}

export function createTempDir(prefix = 'codemachine-import-'): string {
  const dir = getTempPath(prefix);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function cloneToTemp(url: string): Promise<string> {
  const tempDir = createTempDir();
  await cloneRepo(url, tempDir);
  removeGitDir(tempDir);
  return tempDir;
}

export function copyLocalToTemp(localPath: string): string {
  const tempDir = createTempDir();
  cpSync(localPath, tempDir, { recursive: true });
  removeGitDir(tempDir);
  return tempDir;
}

export function atomicMoveToInstall(tempPath: string, installPath: string): string {
  if (existsSync(installPath)) {
    rmSync(installPath, { recursive: true, force: true });
  }

  const parentDir = join(installPath, '..');
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  renameSync(tempPath, installPath);
  return installPath;
}

export function cleanTemp(tempPath: string): void {
  if (existsSync(tempPath)) {
    rmSync(tempPath, { recursive: true, force: true });
  }
}
