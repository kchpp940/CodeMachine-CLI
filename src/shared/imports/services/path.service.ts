/**
 * Path service — computes all paths needed for the import system.
 *
 * Single source of truth for:
 * - install paths
 * - temp staging paths
 * - backup paths
 *
 * No other module should compute import-related paths directly.
 */

import { getImportsDir } from '../paths.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';

export function getInstallPath(repoName: string): string {
  return join(getImportsDir(), repoName);
}

export function getTempPath(prefix = 'codemachine-import-'): string {
  return join(tmpdir(), `${prefix}${randomUUID()}`);
}

export function getBackupPath(repoName: string): string {
  return join(getImportsDir(), `${repoName}.bak`);
}

export function isInstalled(repoName: string): boolean {
  return existsSync(getInstallPath(repoName));
}

export function listInstalledDirectories(): string[] {
  const importsDir = getImportsDir();
  if (!existsSync(importsDir)) {
    return [];
  }

  const entries = readdirSync(importsDir);

  return entries
    .filter((entry) => {
      if (entry === 'registry.json') return false;
      const fullPath = join(importsDir, entry);
      try {
        return statSync(fullPath).isDirectory();
      } catch {
        return false;
      }
    })
    .map((entry) => join(importsDir, entry));
}
