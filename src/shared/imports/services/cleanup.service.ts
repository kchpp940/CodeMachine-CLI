/**
 * Cleanup service for the CodeMachine import system.
 *
 * Centralises all file-system cleanup policies:
 * - Removing an installed package directory
 * - Removing orphaned directories (present on disk but not in registry)
 * - Cleaning up a failed staging (temp + partial install)
 */

import { existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getImportsDir } from '../paths.js';
import { getInstallPath, listInstalledDirectories } from './path.service.js';
import { getAll as getAllRegistered } from './registry.service.js';

export function removeInstallDir(repoName: string): void {
  const installPath = getInstallPath(repoName);
  if (existsSync(installPath)) {
    rmSync(installPath, { recursive: true, force: true });
  }
}

export function removeInstallPath(installPath: string): void {
  if (existsSync(installPath)) {
    rmSync(installPath, { recursive: true, force: true });
  }
}

export function findOrphanedDirs(): string[] {
  const importsDir = getImportsDir();
  if (!existsSync(importsDir)) return [];

  const registeredPaths = new Set(
    getAllRegistered().map((imp) => imp.path),
  );

  const entries = readdirSync(importsDir);
  const orphans: string[] = [];

  for (const entry of entries) {
    if (entry === 'registry.json') continue;
    const fullPath = join(importsDir, entry);
    try {
      if (statSync(fullPath).isDirectory() && !registeredPaths.has(fullPath)) {
        orphans.push(fullPath);
      }
    } catch {
      // skip entries that can't be stat'd
    }
  }

  return orphans;
}

export function removeOrphanedDirs(): string[] {
  const orphans = findOrphanedDirs();
  for (const dir of orphans) {
    rmSync(dir, { recursive: true, force: true });
  }
  return orphans;
}

export function cleanupFailedInstall(
  tempPath: string | null,
  installPath?: string,
): void {
  if (tempPath) {
    rmSync(tempPath, { recursive: true, force: true });
  }
  if (installPath && existsSync(installPath)) {
    rmSync(installPath, { recursive: true, force: true });
  }
}

export function removeRegistryIfEmpty(): void {
  const importsDir = getImportsDir();
  if (!existsSync(importsDir)) return;

  const entries = readdirSync(importsDir);
  const hasContent = entries.some((e) => e !== 'registry.json');
  if (!hasContent) {
    const registryPath = join(importsDir, 'registry.json');
    if (existsSync(registryPath)) {
      rmSync(registryPath, { force: true });
    }
  }
}
