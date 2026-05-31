/**
 * CodeMachine Import System — Public API
 *
 * Only high-level capabilities are exported here.
 * Internal services (registry/path/temp/backup/resolved-paths)
 * are NOT directly exposed — use the installer or path resolver functions instead.
 */

// Types
export type {
  ImportManifest,
  InstalledImport,
  ImportRegistry,
  ResolvedSource,
  ImportOptions,
  ValidationResult,
} from './types.js';

// Install / uninstall / update — the primary public API
export {
  installPackage,
  updatePackage,
  uninstallPackage,
  getImportsDirectory,
  getImportsOverview,
  exportImportsBundle,
  openImportsDirectory,
} from './installer.js';
export type {
  InstallResult,
  UninstallResult,
  ImportsOverview,
  ExportBundleResult,
  OpenDirectoryResult,
} from './installer.js';

// List installed packages — for CLI listing and discovery
export {
  getAllInstalledImports,
  getInstalledImport,
  getImportRoots,
} from './registry.js';

// Import-aware path resolution — for discovering resources across packages
export {
  resolvePromptPath,
  resolvePromptFolder,
  resolveWorkflowTemplate,
  resolvePathWithImports,
  getAllWorkflowDirectories,
  getAllPromptDirectories,
} from './resolve.js';

// Default packages
export { DEFAULT_PACKAGES } from './defaults.js';
export {
  ensureDefaultPackagesSync,
  ensureDefaultPackages,
  checkDefaultPackageUpdates,
} from './auto-import.js';
