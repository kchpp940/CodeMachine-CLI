/**
 * Shared install / uninstall / update logic for CodeMachine imports.
 *
 * Used by the CLI `import` command, the TUI import dialog,
 * and the auto-import system for default packages.
 *
 * This is a pure orchestrator — it calls services in sequence.
 * All path computation, registry operations, and filesystem work
 * delegates to internal services.
 */

import { metrics } from '@opentelemetry/api';
import { otel_debug, otel_info, otel_warn } from '../logging/logger.js';
import { LOGGER_NAMES } from '../logging/otel-logger.js';
import { resolveSource } from './services/source-resolver.service.js';
import {
  cloneToTemp,
  copyLocalToTemp,
  atomicMoveToInstall,
  cleanTemp,
} from './services/temp-installer.service.js';
import { validateImport } from './services/manifest-validator.service.js';
import { cleanupFailedInstall, removeInstallPath } from './services/cleanup.service.js';
import { getInstallPath } from './services/path.service.js';
import { ensureImportsDir, getImportsDir } from './paths.js';
import { resolve as resolvePaths } from './services/resolved-paths.service.js';
import {
  getByName as getRegisteredByName,
  getAll as getAllRegistered,
  add as addToRegistry,
  remove as removeFromRegistry,
} from './services/registry.service.js';
import { parseManifest } from './manifest.js';
import type { InstalledImport } from './types.js';

export interface InstallResult {
  success: boolean;
  name?: string;
  version?: string;
  location?: string;
  error?: string;
  errorDetails?: string;
}

export interface UninstallResult {
  success: boolean;
  name?: string;
  error?: string;
}

const cliMeter = metrics.getMeter('codemachine.cli');
const importInstallDurationMs = cliMeter.createHistogram('import_install_duration_ms', {
  description: 'Duration of package import installs in milliseconds',
  unit: 'ms',
});

function classifyError(msg: string): string {
  if (
    msg.includes('Could not resolve host') ||
    msg.includes('getaddrinfo') ||
    msg.includes('ENETUNREACH') ||
    msg.includes('Network is unreachable') ||
    msg.includes('ENOTFOUND')
  ) {
    return 'Network unreachable';
  }
  if (msg.includes('timed out') || msg.includes('Timeout')) {
    return 'Connection timed out';
  }
  if (
    msg.includes('spawn git ENOENT') ||
    (msg.includes('Failed to run git') && msg.includes('ENOENT'))
  ) {
    return 'Git is not installed';
  }
  if (msg.includes('403') && (msg.includes('rate') || msg.includes('limit'))) {
    return 'Access denied';
  }
  if (msg.includes('Could not find repository')) {
    return 'Repository not found';
  }
  if (msg.includes('git clone failed')) {
    return 'Failed to clone repository';
  }
  if (msg.includes('ENOENT') || msg.includes('no such file')) {
    return 'Local folder not found';
  }
  if (msg.includes('EACCES') || msg.includes('permission denied')) {
    return 'Permission denied';
  }
  return msg;
}

export async function installPackage(source: string): Promise<InstallResult> {
  otel_info(LOGGER_NAMES.CLI, '[installer] Installing package from source: %s', [source]);

  let tempPath: string | null = null;
  let installPath: string | null = null;

  try {
    const installStart = performance.now();
    const resolved = await resolveSource(source);
    installPath = getInstallPath(resolved.repoName);

    otel_debug(
      LOGGER_NAMES.CLI,
      '[installer] Resolved source for %s: type=%s, url=%s, repo=%s',
      [source, resolved.type, resolved.url, resolved.repoName],
    );

    // Stage into temp directory
    if (resolved.type === 'local-path') {
      otel_info(LOGGER_NAMES.CLI, '[installer] Copying local package into temp staging', []);
      tempPath = copyLocalToTemp(resolved.url);
    } else {
      otel_info(LOGGER_NAMES.CLI, '[installer] Cloning remote package %s into temp staging', [resolved.url]);
      tempPath = await cloneToTemp(resolved.url);
    }

    // Validate in temp directory
    const validation = validateImport(tempPath);
    if (!validation.valid) {
      otel_warn(
        LOGGER_NAMES.CLI,
        '[installer] Validation failed for %s: %s',
        [resolved.repoName, validation.errors.join('; ')],
      );
      cleanTemp(tempPath);
      tempPath = null;

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

    // Parse manifest in temp
    const manifest = parseManifest(tempPath);
    if (!manifest) {
      otel_warn(LOGGER_NAMES.CLI, '[installer] Manifest parse failed for %s', [resolved.repoName]);
      cleanTemp(tempPath);
      tempPath = null;
      return {
        success: false,
        error: 'Failed to parse manifest',
        errorDetails: 'The codemachine.json file could not be parsed.',
      };
    }

    // Atomic move: temp → final install path
    otel_info(LOGGER_NAMES.CLI, '[installer] Moving validated package from temp to %s', [installPath]);
    atomicMoveToInstall(tempPath, installPath);
    tempPath = null;

    // Register with properly computed resolved paths
    const installed: InstalledImport = {
      name: manifest.name,
      version: manifest.version,
      source,
      path: installPath,
      installedAt: new Date().toISOString(),
      resolvedPaths: resolvePaths(installPath, manifest),
    };
    addToRegistry(installed);

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

    cleanupFailedInstall(tempPath, installPath ?? undefined);

    return { success: false, error: classifyError(msg) };
  }
}

export async function updatePackage(name: string, source: string): Promise<InstallResult> {
  otel_info(LOGGER_NAMES.CLI, '[installer] Updating package %s from source: %s', [name, source]);
  return installPackage(source);
}

export function uninstallPackage(name: string): UninstallResult {
  otel_info(LOGGER_NAMES.CLI, '[installer] Uninstalling package %s', [name]);

  const installed = getRegisteredByName(name);
  if (!installed) {
    otel_warn(LOGGER_NAMES.CLI, '[installer] Package not found: %s', [name]);
    return { success: false, name, error: 'Package not found' };
  }

  removeInstallPath(installed.path);
  removeFromRegistry(installed.name);

  otel_info(LOGGER_NAMES.CLI, '[installer] Uninstalled %s', [installed.name]);
  return { success: true, name: installed.name };
}

export function getImportsDirectory(): string {
  ensureImportsDir();
  return getImportsDir();
}

export interface ImportsOverview {
  packageCount: number;
  packages: Array<{
    name: string;
    version: string;
    source: string;
    installedAt: string;
  }>;
}

export function getImportsOverview(): ImportsOverview {
  ensureImportsDir();
  const installed = getAllRegistered();

  return {
    packageCount: installed.length,
    packages: installed.map((imp) => ({
      name: imp.name,
      version: imp.version,
      source: imp.source,
      installedAt: imp.installedAt,
    })),
  };
}

export interface ExportBundleResult {
  success: boolean;
  bundlePath?: string;
  packageCount?: number;
  error?: string;
}

export async function exportImportsBundle(targetPath: string): Promise<ExportBundleResult> {
  otel_info(LOGGER_NAMES.CLI, '[installer] Exporting imports bundle to: %s', [targetPath]);

  try {
    const importsDir = getImportsDirectory();
    const overview = getImportsOverview();

    return {
      success: true,
      bundlePath: importsDir,
      packageCount: overview.packageCount,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    otel_warn(LOGGER_NAMES.CLI, '[installer] Export bundle failed: %s', [msg]);
    return { success: false, error: msg };
  }
}

export interface OpenDirectoryResult {
  success: boolean;
  packageCount?: number;
  error?: string;
}

export function openImportsDirectory(): OpenDirectoryResult {
  otel_info(LOGGER_NAMES.CLI, '[installer] Opening imports directory', []);

  try {
    const importsDir = getImportsDirectory();
    const overview = getImportsOverview();

    return {
      success: true,
      packageCount: overview.packageCount,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    otel_warn(LOGGER_NAMES.CLI, '[installer] Open directory failed: %s', [msg]);
    return { success: false, error: msg };
  }
}

export function getImportsDirectoryPath(): string {
  return getImportsDirectory();
}
