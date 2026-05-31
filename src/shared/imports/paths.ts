/**
 * Path resolution for the CodeMachine import system
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MANIFEST_FILENAME = 'codemachine.json';
const LOCAL_MANIFEST_FILENAME = '.codemachine.json';

const STALE_TEMP_THRESHOLD_MS = 60 * 60 * 1000;

export function getCodemachineHomeDir(): string {
  const override = process.env.CODEMACHINE_HOME;
  if (override && override.length > 0) return override;
  return join(homedir(), '.codemachine');
}

export function getImportsDir(): string {
  const override = process.env.CODEMACHINE_IMPORTS_DIR;
  if (override && override.length > 0) return override;
  return join(getCodemachineHomeDir(), 'imports');
}

export function getRegistryPath(): string {
  return join(getImportsDir(), 'registry.json');
}

export function ensureImportsDir(): string {
  const importsDir = getImportsDir();
  if (!existsSync(importsDir)) {
    mkdirSync(importsDir, { recursive: true });
  }
  return importsDir;
}

export function getImportInstallPath(repoName: string): string {
  return join(getImportsDir(), repoName);
}

function hasManifest(dirPath: string): boolean {
  return existsSync(join(dirPath, LOCAL_MANIFEST_FILENAME)) ||
         existsSync(join(dirPath, MANIFEST_FILENAME));
}

export function isImportInstalled(repoName: string): boolean {
  const installPath = getImportInstallPath(repoName);
  return existsSync(installPath) && hasManifest(installPath);
}

export function getInstalledImportPaths(): string[] {
  const importsDir = getImportsDir();
  if (!existsSync(importsDir)) {
    return [];
  }

  const entries = readdirSync(importsDir);

  return entries
    .filter((entry) => {
      if (entry === 'registry.json') return false;
      if (entry.startsWith('.')) return false;
      const fullPath = join(importsDir, entry);
      try {
        return statSync(fullPath).isDirectory() && hasManifest(fullPath);
      } catch {
        return false;
      }
    })
    .map((entry) => join(importsDir, entry));
}

export function getTempInstallPath(repoName: string): string {
  return join(getImportsDir(), `.tmp-${repoName}-${Date.now()}`);
}

export function getBackupInstallPath(repoName: string): string {
  return join(getImportsDir(), `.backup-${repoName}-${Date.now()}`);
}

export function findBackupDirs(repoName: string): string[] {
  const importsDir = getImportsDir();
  if (!existsSync(importsDir)) {
    return [];
  }

  const prefix = `.backup-${repoName}-`;
  const entries = readdirSync(importsDir);

  return entries
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => join(importsDir, entry))
    .filter((fullPath) => {
      try {
        return statSync(fullPath).isDirectory();
      } catch {
        return false;
      }
    });
}

export type ImportDirKind = 'complete' | 'backup' | 'broken' | 'temp' | 'stale-backup';

export interface ScannedImportDir {
  path: string;
  name: string;
  kind: ImportDirKind;
  hasManifest: boolean;
}

export function scanImportDirs(): ScannedImportDir[] {
  const importsDir = getImportsDir();
  const results: ScannedImportDir[] = [];

  if (!existsSync(importsDir)) {
    return results;
  }

  const entries = readdirSync(importsDir);

  for (const entry of entries) {
    if (entry === 'registry.json') continue;

    const fullPath = join(importsDir, entry);
    try {
      if (!statSync(fullPath).isDirectory()) continue;
    } catch {
      continue;
    }

    let kind: ImportDirKind;
    let name = entry;

    if (entry.startsWith('.tmp-')) {
      kind = 'temp';
      name = entry.slice(5);
    } else if (entry.startsWith('.backup-')) {
      kind = 'backup';
      const match = entry.match(/^.backup-(.+)-\d+$/);
      name = match ? match[1] : entry.slice(8);
    } else if (hasManifest(fullPath)) {
      kind = 'complete';
    } else {
      kind = 'broken';
    }

    results.push({
      path: fullPath,
      name,
      kind,
      hasManifest: hasManifest(fullPath),
    });
  }

  return results;
}

function extractTimestampFromTempDir(name: string): number | null {
  const match = name.match(/^.tmp-.+-(\d+)$/);
  if (!match) return null;
  const ts = parseInt(match[1], 10);
  return isNaN(ts) ? null : ts;
}

export function cleanupStaleDirs(): { cleaned: string[] } {
  const importsDir = getImportsDir();
  const cleaned: string[] = [];
  if (!existsSync(importsDir)) {
    return { cleaned };
  }

  const now = Date.now();
  const entries = readdirSync(importsDir);

  for (const entry of entries) {
    if (!entry.startsWith('.tmp-')) continue;

    const fullPath = join(importsDir, entry);
    try {
      if (!statSync(fullPath).isDirectory()) continue;

      const ts = extractTimestampFromTempDir(entry);
      if (ts === null) {
        cleaned.push(fullPath);
        rmSync(fullPath, { recursive: true, force: true });
        continue;
      }

      if (now - ts > STALE_TEMP_THRESHOLD_MS) {
        cleaned.push(fullPath);
        rmSync(fullPath, { recursive: true, force: true });
      }
    } catch {
      // best effort
    }
  }

  return { cleaned };
}
