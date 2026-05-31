/**
 * Registry management for installed CodeMachine imports
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { ImportRegistry, InstalledImport, ImportManifest, ResolvedSource, VersionStrategy, SourceConsistencyCheck } from './types.js';
import { getRegistryPath, ensureImportsDir, getImportInstallPath } from './paths.js';
import { getResolvedPaths } from './manifest.js';

const CURRENT_SCHEMA_VERSION = 1;

/**
 * Load the import registry
 */
export function loadRegistry(): ImportRegistry {
  const registryPath = getRegistryPath();

  if (!existsSync(registryPath)) {
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      imports: {},
    };
  }

  try {
    const content = readFileSync(registryPath, 'utf8');
    const parsed = JSON.parse(content) as ImportRegistry;

    // Handle schema migrations if needed
    if (parsed.schemaVersion !== CURRENT_SCHEMA_VERSION) {
      // Future: migrate schema here
    }

    return parsed;
  } catch {
    // Corrupted registry, start fresh
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      imports: {},
    };
  }
}

/**
 * Save the import registry
 */
export function saveRegistry(registry: ImportRegistry): void {
  ensureImportsDir();
  const registryPath = getRegistryPath();
  writeFileSync(registryPath, JSON.stringify(registry, null, 2));
}

/**
 * Metadata for registering an import
 */
export interface RegisterImportMetadata {
  /** Resolved source information */
  resolvedSource: ResolvedSource;
  /** Digest/hash representing the source content state */
  sourceDigest?: string;
  /** Digest type to help interpret sourceDigest */
  digestType?: 'git-commit' | 'content-hash';
  /** Pinned reference (commit/tag/branch) */
  pinnedRef?: string;
  /** Version strategy for future updates */
  versionStrategy?: VersionStrategy;
}

/**
 * Check if a new source is consistent with an existing import
 * Returns check result with message explaining the inconsistency if any
 */
export function checkSourceConsistency(
  existingImport: InstalledImport,
  newSource: string,
  newSourceUrl: string
): SourceConsistencyCheck {
  // Check if source URLs match (normalized)
  const normalizeUrl = (url: string) => url.toLowerCase().replace(/\.git$/, '').replace(/\/$/, '');
  const existingNormalized = normalizeUrl(existingImport.sourceUrl);
  const newNormalized = normalizeUrl(newSourceUrl);

  if (existingNormalized === newNormalized) {
    return {
      isConsistent: true,
      existingSource: existingImport.source,
      newSource,
      message: 'Sources match',
    };
  }

  return {
    isConsistent: false,
    existingSource: existingImport.source,
    newSource,
    message: `Source mismatch: existing import '${existingImport.name}' was installed from '${existingImport.source}', but new source is '${newSource}'. Use --force to rebind to the new source.`,
  };
}

/**
 * Find an existing import by source (for consistency checks)
 */
export function findImportBySource(sourceUrl: string): InstalledImport | undefined {
  const registry = loadRegistry();
  const normalizeUrl = (url: string) => url.toLowerCase().replace(/\.git$/, '').replace(/\/$/, '');
  const normalized = normalizeUrl(sourceUrl);

  return Object.values(registry.imports).find(
    (imp) => normalizeUrl(imp.sourceUrl) === normalized
  );
}

/**
 * Register an installed import
 */
export function registerImport(
  repoName: string,
  manifest: ImportManifest,
  source: string,
  metadata: RegisterImportMetadata
): InstalledImport {
  const registry = loadRegistry();
  const installPath = getImportInstallPath(repoName);
  const resolvedPaths = getResolvedPaths(installPath, manifest);
  const now = new Date().toISOString();

  const existingImport = registry.imports[manifest.name];

  const installedImport: InstalledImport = {
    name: manifest.name,
    version: manifest.version,
    source,
    sourceUrl: metadata.resolvedSource.url,
    sourceType: metadata.resolvedSource.type,
    owner: metadata.resolvedSource.owner,
    repoName,
    sourceDigest: metadata.sourceDigest,
    digestType: metadata.digestType,
    pinnedRef: metadata.pinnedRef ?? existingImport?.pinnedRef,
    path: installPath,
    installedAt: existingImport?.installedAt ?? now,
    updatedAt: existingImport ? now : undefined,
    versionStrategy: metadata.versionStrategy ?? existingImport?.versionStrategy,
    resolvedPaths,
  };

  registry.imports[manifest.name] = installedImport;
  saveRegistry(registry);

  return installedImport;
}

/**
 * Update version strategy for an existing import
 */
export function updateImportVersionStrategy(
  name: string,
  versionStrategy: VersionStrategy,
  pinnedRef?: string
): InstalledImport | null {
  const registry = loadRegistry();
  const imp = registry.imports[name];

  if (!imp) {
    return null;
  }

  imp.versionStrategy = versionStrategy;
  if (versionStrategy === 'pin' && pinnedRef) {
    imp.pinnedRef = pinnedRef;
  } else if (versionStrategy !== 'pin') {
    delete imp.pinnedRef;
  }

  saveRegistry(registry);
  return imp;
}

/**
 * Unregister an import
 */
export function unregisterImport(name: string): boolean {
  const registry = loadRegistry();

  if (!registry.imports[name]) {
    return false;
  }

  delete registry.imports[name];
  saveRegistry(registry);
  return true;
}

/**
 * Get an installed import by name
 */
export function getInstalledImport(name: string): InstalledImport | undefined {
  const registry = loadRegistry();
  return registry.imports[name];
}

/**
 * Get all installed imports
 */
export function getAllInstalledImports(): InstalledImport[] {
  const registry = loadRegistry();
  return Object.values(registry.imports);
}

/**
 * Check if an import is registered by name
 */
export function isImportRegistered(name: string): boolean {
  const registry = loadRegistry();
  return name in registry.imports;
}

/**
 * Get all registered import root paths (for agent/workflow discovery)
 */
export function getImportRoots(): string[] {
  const imports = getAllInstalledImports();
  return imports.map((imp) => imp.path);
}
