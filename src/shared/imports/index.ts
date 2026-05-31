/**
 * CodeMachine Import System
 *
 * Provides functionality for importing external workflow packages
 * from GitHub and other git repositories.
 */

// Types
export type {
  ImportManifest,
  InstalledImport,
  ImportRegistry,
  ResolvedSource,
  ImportOptions,
  ValidationResult,
  VersionStrategy,
  SourceConsistencyCheck,
} from './types.js';

// Path utilities
export {
  getCodemachineHomeDir,
  getImportsDir,
  getRegistryPath,
  ensureImportsDir,
  getImportInstallPath,
  isImportInstalled,
  getInstalledImportPaths,
} from './paths.js';

// Manifest parsing
export {
  parseManifest,
  findManifestPath,
  getResolvedPaths,
  validateImport,
  getManifestFilename,
} from './manifest.js';

// Registry management
export {
  loadRegistry,
  saveRegistry,
  registerImport,
  unregisterImport,
  getInstalledImport,
  getAllInstalledImports,
  isImportRegistered,
  getImportRoots,
  checkSourceConsistency,
  findImportBySource,
  updateImportVersionStrategy,
} from './registry.js';
export type { RegisterImportMetadata } from './registry.js';

// Source resolution
export {
  resolveSource,
  extractRepoName,
} from './resolver.js';

// Import-aware path resolution
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

// Auto-import / auto-update
export {
  ensureDefaultPackagesSync,
  ensureDefaultPackages,
  checkDefaultPackageUpdates,
} from './auto-import.js';

// Shared installer
export { installPackage, updatePackage, getImportDetails } from './installer.js';
export type { InstallResult } from './installer.js';
