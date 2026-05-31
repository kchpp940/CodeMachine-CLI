/**
 * Shared install/update logic for CodeMachine imports.
 *
 * Atomic installation:
 * 1. Clone/copy into .tmp-* temp directory
 * 2. Validate manifest + structure in temp
 * 3. If updating: rename existing dir to .backup-* (atomic)
 * 4. rename temp → final path (atomic)
 * 5. On success: register in registry, delete backup
 *    On failure at step 3/4: restore backup, delete temp
 *
 * The registry is ONLY written after the directory is fully in place.
 */

import { existsSync, rmSync, cpSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { metrics } from '@opentelemetry/api';
import { otel_debug, otel_info, otel_warn } from '../logging/logger.js';
import { LOGGER_NAMES } from '../logging/otel-logger.js';
import {
  resolveSource,
  ensureImportsDir,
  getImportInstallPath,
  isImportInstalled,
  validateImport,
  parseManifest,
  registerImport,
  getTempInstallPath,
  getBackupInstallPath,
  cleanupStaleDirs,
} from './index.js';

export interface InstallResult {
  success: boolean;
  name?: string;
  version?: string;
  location?: string;
  error?: string;
  errorDetails?: string;
  rolledBack?: boolean;
}

const cliMeter = metrics.getMeter('codemachine.cli');
const importInstallDurationMs = cliMeter.createHistogram('import_install_duration_ms', {
  description: 'Duration of package import installs in milliseconds',
  unit: 'ms',
});

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

function removeGitDir(repoPath: string): void {
  const gitDir = join(repoPath, '.git');
  if (existsSync(gitDir)) {
    rmSync(gitDir, { recursive: true, force: true });
  }
}

function copyLocalFolder(sourcePath: string, destPath: string): void {
  cpSync(sourcePath, destPath, { recursive: true });
  removeGitDir(destPath);
}

function tryRestoreBackup(backupPath: string | null, installPath: string): boolean {
  if (!backupPath || !existsSync(backupPath)) return false;
  try {
    if (existsSync(installPath)) {
      rmSync(installPath, { recursive: true, force: true });
    }
    renameSync(backupPath, installPath);
    return true;
  } catch {
    return false;
  }
}

export async function installPackage(source: string): Promise<InstallResult> {
  otel_info(LOGGER_NAMES.CLI, '[installer] Installing package from source: %s', [source]);

  const installStart = performance.now();
  let tempPath: string | null = null;
  let backupPath: string | null = null;
  let installPath: string | null = null;

  try {
    const resolved = await resolveSource(source);
    installPath = getImportInstallPath(resolved.repoName);
    tempPath = getTempInstallPath(resolved.repoName);

    otel_debug(
      LOGGER_NAMES.CLI,
      '[installer] Resolved source for %s: type=%s, url=%s, repo=%s',
      [source, resolved.type, resolved.url, resolved.repoName]
    );

    ensureImportsDir();

    cleanupStaleDirs();

    // --- Step 1: install into temp ---
    if (resolved.type === 'local-path') {
      otel_info(LOGGER_NAMES.CLI, '[installer] Copying local package into temp: %s', [tempPath]);
      copyLocalFolder(resolved.url, tempPath);
    } else {
      otel_info(LOGGER_NAMES.CLI, '[installer] Cloning remote package into temp: %s', [tempPath]);
      await cloneRepo(resolved.url, tempPath);
      removeGitDir(tempPath);
    }

    // --- Step 2: validate in temp (if this fails, old install is untouched) ---
    const validation = validateImport(tempPath);
    if (!validation.valid) {
      otel_warn(LOGGER_NAMES.CLI, '[installer] Validation failed for %s: %s', [
        resolved.repoName,
        validation.errors.join('; '),
      ]);
      rmSync(tempPath, { recursive: true, force: true });

      const hasMissingManifest = validation.errors.some((e) =>
        e.includes('codemachine.json'),
      );

      if (hasMissingManifest) {
        return {
          success: false,
          error: 'Missing manifest file',
          errorDetails:
            resolved.type === 'local-path'
              ? 'The folder must contain a .codemachine.json or codemachine.json manifest file.'
              : 'The repository must contain a codemachine.json manifest file in the root directory.',
        };
      }

      return {
        success: false,
        error: 'Validation failed',
        errorDetails: validation.errors.join('\n'),
      };
    }

    const manifest = parseManifest(tempPath);
    if (!manifest) {
      otel_warn(LOGGER_NAMES.CLI, '[installer] Manifest parse failed for %s', [resolved.repoName]);
      rmSync(tempPath, { recursive: true, force: true });
      return {
        success: false,
        error: 'Failed to parse manifest',
        errorDetails: 'The codemachine.json file could not be parsed.',
      };
    }

    // --- Step 3: if updating, back up existing install (atomic rename) ---
    const isUpdate = isImportInstalled(resolved.repoName);
    if (isUpdate) {
      backupPath = getBackupInstallPath(resolved.repoName);
      otel_info(LOGGER_NAMES.CLI, '[installer] Backing up existing install to: %s', [backupPath]);
      try {
        renameSync(installPath!, backupPath);
      } catch (e) {
        otel_warn(LOGGER_NAMES.CLI, '[installer] Failed to create backup: %s', [
          e instanceof Error ? e.message : String(e),
        ]);
        rmSync(tempPath, { recursive: true, force: true });
        throw e;
      }
    }

    // --- Step 4: atomically move temp → final ---
    try {
      renameSync(tempPath!, installPath!);
    } catch (e) {
      otel_warn(LOGGER_NAMES.CLI, '[installer] Atomic move failed: %s', [
        e instanceof Error ? e.message : String(e),
      ]);

      const rolledBack = tryRestoreBackup(backupPath, installPath!);

      if (existsSync(tempPath)) {
        rmSync(tempPath, { recursive: true, force: true });
      }

      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
        rolledBack,
      };
    }

    // --- Step 5: success — write registry, clean up ---
    registerImport(resolved.repoName, manifest, source);

    if (backupPath && existsSync(backupPath)) {
      rmSync(backupPath, { recursive: true, force: true });
    }

    importInstallDurationMs.record(Math.round(performance.now() - installStart), {
      'import.name': manifest.name,
      'import.version': manifest.version,
      'source.type': resolved.type,
    });
    otel_info(LOGGER_NAMES.CLI, '[installer] Installed %s@%s', [manifest.name, manifest.version]);

    return {
      success: true,
      name: manifest.name,
      version: manifest.version,
      location: installPath,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    otel_warn(LOGGER_NAMES.CLI, '[installer] Install failed for source %s: %s', [source, msg]);

    if (tempPath && existsSync(tempPath)) {
      rmSync(tempPath, { recursive: true, force: true });
    }

    const rolledBack = installPath
      ? tryRestoreBackup(backupPath, installPath)
      : false;

    return classifyError(msg, rolledBack);
  }
}

function classifyError(msg: string, rolledBack: boolean): InstallResult {
  if (
    msg.includes('Could not resolve host') ||
    msg.includes('getaddrinfo') ||
    msg.includes('ENETUNREACH') ||
    msg.includes('Network is unreachable') ||
    msg.includes('ENOTFOUND')
  ) {
    return { success: false, error: 'Network unreachable', rolledBack };
  }
  if (msg.includes('timed out') || msg.includes('Timeout')) {
    return { success: false, error: 'Connection timed out', rolledBack };
  }
  if (
    msg.includes('spawn git ENOENT') ||
    (msg.includes('Failed to run git') && msg.includes('ENOENT'))
  ) {
    return { success: false, error: 'Git is not installed', rolledBack };
  }
  if (msg.includes('403') && (msg.includes('rate') || msg.includes('limit'))) {
    return { success: false, error: 'Access denied', rolledBack };
  }
  if (msg.includes('Could not find repository')) {
    return { success: false, error: 'Repository not found', rolledBack };
  }
  if (msg.includes('git clone failed')) {
    return { success: false, error: 'Failed to clone repository', rolledBack };
  }
  if (msg.includes('ENOENT') || msg.includes('no such file')) {
    return { success: false, error: 'Local folder not found', rolledBack };
  }
  if (msg.includes('EACCES') || msg.includes('permission denied')) {
    return { success: false, error: 'Permission denied', rolledBack };
  }
  return { success: false, error: msg, rolledBack };
}

export async function updatePackage(name: string, source: string): Promise<InstallResult> {
  otel_info(LOGGER_NAMES.CLI, '[installer] Updating package %s from source: %s', [name, source]);
  return installPackage(source);
}
