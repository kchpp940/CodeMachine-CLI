/**
 * Shared install/update logic for CodeMachine imports.
 *
 * Used by both the CLI `import` command and the TUI import dialog,
 * as well as the auto-import system for default packages.
 *
 * Version strategies:
 * - 'pin': Install a specific commit/tag/branch and stay at that version
 * - 'update': Always pull the latest version from source (default)
 * - 'keep': Keep the currently installed version, don't modify files or registry
 */

import { existsSync, rmSync, cpSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { metrics } from '@opentelemetry/api';
import { otel_debug, otel_info, otel_warn } from '../logging/logger.js';
import { LOGGER_NAMES } from '../logging/otel-logger.js';
import type { VersionStrategy, ResolvedSource, SourceConsistencyCheck } from './types.js';
import {
  resolveSource,
  ensureImportsDir,
  getImportInstallPath,
  isImportInstalled,
  validateImport,
  parseManifest,
  findManifestPath,
  registerImport,
  getInstalledImport,
  getAllInstalledImports,
  checkSourceConsistency,
} from './index.js';

export interface InstallResult {
  success: boolean;
  name?: string;
  version?: string;
  location?: string;
  error?: string;
  errorDetails?: string;
  skipped?: boolean;
  skippedReason?: string;
  previousVersion?: string;
  newVersion?: string;
  pinnedRef?: string;
  sourceDigest?: string;
  digestType?: 'git-commit' | 'content-hash';
  sourceCheck?: SourceConsistencyCheck;
}

const cliMeter = metrics.getMeter('codemachine.cli');
const importInstallDurationMs = cliMeter.createHistogram('import_install_duration_ms', {
  description: 'Duration of package import installs in milliseconds',
  unit: 'ms',
});

/**
 * Get the git commit digest from a repository
 */
function getGitDigest(repoPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const gitDir = join(repoPath, '.git');
    if (!existsSync(gitDir)) {
      resolve(null);
      return;
    }

    const proc = spawn('git', ['rev-parse', 'HEAD'], {
      cwd: repoPath,
      stdio: 'pipe',
    });

    let stdout = '';
    if (proc.stdout) {
      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
    }

    proc.on('close', (code: number | null) => {
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim().substring(0, 7));
      } else {
        resolve(null);
      }
    });

    proc.on('error', () => {
      resolve(null);
    });
  });
}

/**
 * Recursively list all files in a directory (sorted for deterministic hashing)
 */
function listFilesRecursive(dir: string, baseDir: string = dir): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(fullPath, baseDir));
    } else if (entry.isFile()) {
      files.push(relative(baseDir, fullPath));
    }
  }

  return files;
}

/**
 * Compute content-based digest for a non-git directory
 * Hash = SHA256(manifest_content + sorted_file_list)
 */
function computeContentDigest(dir: string, manifestPath: string): string | null {
  try {
    const hash = createHash('sha256');

    if (existsSync(manifestPath)) {
      hash.update(readFileSync(manifestPath, 'utf8'));
    }

    const files = listFilesRecursive(dir);
    hash.update(files.join('\n'));

    return hash.digest('hex').substring(0, 12);
  } catch {
    return null;
  }
}

/**
 * Compute source digest for a directory
 * - If .git exists: return git commit hash
 * - Otherwise: return content-based hash
 */
async function computeSourceDigest(
  dir: string,
  manifestPath: string
): Promise<{ digest: string | null; type: 'git-commit' | 'content-hash' | null }> {
  const gitDigest = await getGitDigest(dir);
  if (gitDigest) {
    return { digest: gitDigest, type: 'git-commit' };
  }

  const contentDigest = computeContentDigest(dir, manifestPath);
  if (contentDigest) {
    return { digest: contentDigest, type: 'content-hash' };
  }

  return { digest: null, type: null };
}

/**
 * Resolve a remote ref (tag/branch/commit) to its actual commit hash
 * using git ls-remote, without cloning the repo.
 * Returns the short (7-char) commit hash, or null if resolution fails.
 */
function resolveRefToCommit(remoteUrl: string, ref: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn('git', ['ls-remote', remoteUrl, ref], {
      stdio: 'pipe',
    });

    let stdout = '';
    if (proc.stdout) {
      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
    }

    proc.on('close', (code: number | null) => {
      if (code === 0 && stdout.trim()) {
        const lines = stdout.trim().split('\n');
        const firstLine = lines[0];
        const hash = firstLine.split('\t')[0];
        if (hash && /^[0-9a-f]{40}$/i.test(hash)) {
          resolve(hash.substring(0, 7));
          return;
        }
      }
      resolve(null);
    });

    proc.on('error', () => {
      resolve(null);
    });
  });
}

/**
 * Checkout a specific ref (commit/tag/branch) in a cloned repo
 */
function checkoutRef(repoPath: string, ref: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['checkout', ref], {
      cwd: repoPath,
      stdio: 'pipe',
    });

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
        reject(new Error(`Failed to checkout '${ref}': ${stderr}`));
      }
    });

    proc.on('error', (err: Error) => {
      reject(new Error(`Failed to run git checkout: ${err.message}`));
    });
  });
}

/**
 * Clone a git repository.
 */
function cloneRepo(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['clone', url, destPath];
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

/**
 * Remove .git directory from a cloned repo.
 */
function removeGitDir(repoPath: string): void {
  const gitDir = join(repoPath, '.git');
  if (existsSync(gitDir)) {
    rmSync(gitDir, { recursive: true, force: true });
  }
}

/**
 * Copy a local folder to the imports directory.
 */
function copyLocalFolder(sourcePath: string, destPath: string): void {
  cpSync(sourcePath, destPath, { recursive: true });
  removeGitDir(destPath);
}

/**
 * Find an existing installed import by repo name or package name
 */
function findExistingImport(repoName: string, packageName?: string) {
  const allImports = getAllInstalledImports();

  if (packageName) {
    const byName = allImports.find((imp) => imp.name === packageName);
    if (byName) return byName;
  }

  return allImports.find(
    (imp) => imp.repoName === repoName || imp.path.endsWith(`/${repoName}`)
  );
}

/**
 * Options for installing a package
 */
export interface InstallPackageOptions {
  /** Version strategy */
  versionStrategy?: VersionStrategy;
  /** Specific ref to pin (commit/tag/branch) - only used with 'pin' strategy */
  pinRef?: string;
  /** Force rebind to a different source (bypasses source consistency check) */
  forceRebind?: boolean;
}

/**
 * Install a package from a source string (GitHub owner/repo, URL, or local path).
 * Handles resolution, cloning/copying, validation, and registry registration.
 *
 * @param source - Source string (GitHub repo, URL, or local path)
 * @param options - Installation options
 */
export async function installPackage(
  source: string,
  options: InstallPackageOptions = {}
): Promise<InstallResult> {
  const { versionStrategy = 'update', pinRef, forceRebind = false } = options;

  otel_info(
    LOGGER_NAMES.CLI,
    '[installer] Installing package from source: %s (strategy: %s, pinRef: %s)',
    [source, versionStrategy, pinRef || 'none']
  );

  try {
    const installStart = performance.now();
    const resolved = await resolveSource(source);
    const installPath = getImportInstallPath(resolved.repoName);

    otel_debug(
      LOGGER_NAMES.CLI,
      '[installer] Resolved source for %s: type=%s, url=%s, repo=%s',
      [source, resolved.type, resolved.url, resolved.repoName]
    );

    // First, check for any existing import with the same repo name
    let existingImport = findExistingImport(resolved.repoName);

    // If we found an existing import, check source consistency first (unless force)
    if (existingImport && !forceRebind) {
      const consistencyCheck = checkSourceConsistency(existingImport, source, resolved.url);
      if (!consistencyCheck.isConsistent) {
        otel_warn(
          LOGGER_NAMES.CLI,
          '[installer] Source mismatch detected: %s',
          [consistencyCheck.message]
        );
        return {
          success: false,
          error: 'Source mismatch',
          errorDetails: consistencyCheck.message,
          sourceCheck: consistencyCheck,
        };
      }
    }

    // Strategy-specific skip logic
    if (existingImport) {
      // KEEP: always skip, don't modify anything
      if (versionStrategy === 'keep') {
        otel_info(
          LOGGER_NAMES.CLI,
          '[installer] Keep strategy: preserving current version without modifications',
          []
        );
        return {
          success: true,
          skipped: true,
          skippedReason: 'keep-strategy',
          name: existingImport.name,
          version: existingImport.version,
          location: existingImport.path,
        };
      }

      // PIN: skip only if the source digest matches
      // For remote sources: resolve ref to commit and compare
      // For local sources: compute digest and compare
      if (versionStrategy === 'pin') {
        const refToCheck = pinRef || 'HEAD';

        if (resolved.type !== 'local-path') {
          const remoteCommit = await resolveRefToCommit(resolved.url, refToCheck);

          if (remoteCommit && existingImport.sourceDigest === remoteCommit) {
            otel_info(
              LOGGER_NAMES.CLI,
              '[installer] Pin strategy: resolved commit %s matches stored, skipping',
              [remoteCommit]
            );
            return {
              success: true,
              skipped: true,
              skippedReason: 'already-at-ref',
              name: existingImport.name,
              version: existingImport.version,
              location: existingImport.path,
              sourceDigest: existingImport.sourceDigest,
              digestType: existingImport.digestType,
              pinnedRef: existingImport.pinnedRef,
            };
          }

          if (remoteCommit) {
            otel_info(
              LOGGER_NAMES.CLI,
              '[installer] Pin strategy: ref %s resolves to %s (stored: %s), proceeding with reinstall',
              [refToCheck, remoteCommit, existingImport.sourceDigest || 'none']
            );
          } else {
            otel_info(
              LOGGER_NAMES.CLI,
              '[installer] Pin strategy: could not resolve ref %s remotely, proceeding with reinstall',
              [refToCheck]
            );
          }
        } else {
          // For local-path sources, compute content digest and compare
          const localManifestPath = findManifestPath(resolved.url);
          if (localManifestPath) {
            const { digest } = await computeSourceDigest(resolved.url, localManifestPath);
            if (digest && existingImport.sourceDigest === digest) {
              otel_info(
                LOGGER_NAMES.CLI,
                '[installer] Pin strategy: local source digest matches stored, skipping',
                []
              );
              return {
                success: true,
                skipped: true,
                skippedReason: 'already-at-ref',
                name: existingImport.name,
                version: existingImport.version,
                location: existingImport.path,
                sourceDigest: existingImport.sourceDigest,
                digestType: existingImport.digestType,
                pinnedRef: existingImport.pinnedRef,
              };
            }
          }
        }
      }

      // UPDATE: always proceed with reinstall to get latest
    }

    // Proceed with installation/update
    if (existingImport) {
      otel_info(
        LOGGER_NAMES.CLI,
        '[installer] Existing install found, replacing in %s',
        [installPath]
      );
      rmSync(installPath, { recursive: true, force: true });
    }

    ensureImportsDir();

    let sourceDigest: string | undefined;
    let digestType: 'git-commit' | 'content-hash' | undefined;

    if (resolved.type === 'local-path') {
      otel_info(LOGGER_NAMES.CLI, '[installer] Copying local package into %s', [installPath]);
      copyLocalFolder(resolved.url, installPath);
    } else {
      otel_info(
        LOGGER_NAMES.CLI,
        '[installer] Cloning remote package %s into %s',
        [resolved.url, installPath]
      );
      await cloneRepo(resolved.url, installPath);

      // If pinning to a specific ref, checkout that ref
      if (pinRef) {
        otel_info(LOGGER_NAMES.CLI, '[installer] Checking out ref: %s', [pinRef]);
        try {
          await checkoutRef(installPath, pinRef);
        } catch (err) {
          rmSync(installPath, { recursive: true, force: true });
          return {
            success: false,
            error: `Failed to checkout ref '${pinRef}'`,
            errorDetails: err instanceof Error ? err.message : String(err),
          };
        }
      }

      removeGitDir(installPath);
    }

    // Validate
    const validation = validateImport(installPath);
    if (!validation.valid) {
      otel_warn(
        LOGGER_NAMES.CLI,
        '[installer] Validation failed for %s: %s',
        [resolved.repoName, validation.errors.join('; ')]
      );
      rmSync(installPath, { recursive: true, force: true });

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

    // Compute source digest AFTER validation (so we know manifest exists)
    const manifestPath = findManifestPath(installPath);
    if (manifestPath) {
      const digestResult = await computeSourceDigest(installPath, manifestPath);
      sourceDigest = digestResult.digest ?? undefined;
      digestType = digestResult.type ?? undefined;
    }

    // Register
    const manifest = parseManifest(installPath);
    if (!manifest) {
      otel_warn(LOGGER_NAMES.CLI, '[installer] Manifest parse failed for %s', [resolved.repoName]);
      rmSync(installPath, { recursive: true, force: true });
      return {
        success: false,
        error: 'Failed to parse manifest',
        errorDetails: 'The codemachine.json file could not be parsed.',
      };
    }

    // Double-check consistency with the manifest package name
    const importByPackageName = getInstalledImport(manifest.name);
    if (importByPackageName && importByPackageName.repoName !== resolved.repoName && !forceRebind) {
      const consistencyCheck = checkSourceConsistency(importByPackageName, source, resolved.url);
      if (!consistencyCheck.isConsistent) {
        rmSync(installPath, { recursive: true, force: true });
        return {
          success: false,
          error: 'Package name conflict',
          errorDetails: `A different import with name '${manifest.name}' already exists from '${importByPackageName.source}'. Use --force to rebind.`,
          sourceCheck: consistencyCheck,
        };
      }
    }

    registerImport(resolved.repoName, manifest, source, {
      resolvedSource: resolved,
      sourceDigest,
      digestType,
      pinnedRef: versionStrategy === 'pin' ? (pinRef || sourceDigest) : undefined,
      versionStrategy,
    });

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
      previousVersion: existingImport?.version,
      newVersion: manifest.version,
      sourceDigest,
      digestType,
      pinnedRef: versionStrategy === 'pin' ? (pinRef || sourceDigest) : undefined,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    otel_warn(LOGGER_NAMES.CLI, '[installer] Install failed for source %s: %s', [source, msg]);

    // Network / DNS
    if (
      msg.includes('Could not resolve host') ||
      msg.includes('getaddrinfo') ||
      msg.includes('ENETUNREACH') ||
      msg.includes('Network is unreachable') ||
      msg.includes('ENOTFOUND')
    ) {
      otel_warn(LOGGER_NAMES.CLI, '[installer] Classified install failure: Network unreachable', []);
      return { success: false, error: 'Network unreachable' };
    }
    // Timeout
    if (msg.includes('timed out') || msg.includes('Timeout')) {
      otel_warn(LOGGER_NAMES.CLI, '[installer] Classified install failure: Connection timed out', []);
      return { success: false, error: 'Connection timed out' };
    }
    // Git not installed
    if (
      msg.includes('spawn git ENOENT') ||
      (msg.includes('Failed to run git') && msg.includes('ENOENT'))
    ) {
      otel_warn(LOGGER_NAMES.CLI, '[installer] Classified install failure: Git is not installed', []);
      return { success: false, error: 'Git is not installed' };
    }
    // Rate limiting / access denied
    if (msg.includes('403') && (msg.includes('rate') || msg.includes('limit'))) {
      otel_warn(LOGGER_NAMES.CLI, '[installer] Classified install failure: Access denied', []);
      return { success: false, error: 'Access denied' };
    }
    // Repository not found
    if (msg.includes('Could not find repository')) {
      otel_warn(LOGGER_NAMES.CLI, '[installer] Classified install failure: Repository not found', []);
      return { success: false, error: 'Repository not found' };
    }
    // Clone failure (generic)
    if (msg.includes('git clone failed')) {
      otel_warn(LOGGER_NAMES.CLI, '[installer] Classified install failure: Failed to clone repository', []);
      return { success: false, error: 'Failed to clone repository' };
    }
    // Local path not found
    if (msg.includes('ENOENT') || msg.includes('no such file')) {
      otel_warn(LOGGER_NAMES.CLI, '[installer] Classified install failure: Local folder not found', []);
      return { success: false, error: 'Local folder not found' };
    }
    // Permission denied
    if (msg.includes('EACCES') || msg.includes('permission denied')) {
      otel_warn(LOGGER_NAMES.CLI, '[installer] Classified install failure: Permission denied', []);
      return { success: false, error: 'Permission denied' };
    }

    otel_warn(LOGGER_NAMES.CLI, '[installer] Classified install failure: Unmapped (%s)', [msg]);
    return { success: false, error: msg };
  }
}

/**
 * Update an already-installed package by re-installing from its source.
 * @param name - Package name or repo name
 * @param source - Optional source URL (if not provided, uses stored source)
 */
export async function updatePackage(name: string, source?: string): Promise<InstallResult> {
  const installed = getInstalledImport(name);
  const sourceToUse = source ?? installed?.source;

  if (!sourceToUse) {
    return {
      success: false,
      error: `Import '${name}' is not installed and no source provided`,
    };
  }

  otel_info(LOGGER_NAMES.CLI, '[installer] Updating package %s from source: %s', [name, sourceToUse]);
  return installPackage(sourceToUse, { versionStrategy: 'update' });
}

/**
 * Get detailed information about an installed import
 */
export function getImportDetails(name: string) {
  return getInstalledImport(name);
}
