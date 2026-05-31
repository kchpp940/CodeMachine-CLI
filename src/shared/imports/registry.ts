/**
 * Registry management for installed CodeMachine imports
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { ImportRegistry, InstalledImport, ImportManifest } from './types.js';
import { getRegistryPath, ensureImportsDir, getImportInstallPath } from './paths.js';
import { getResolvedPaths, parseManifest } from './manifest.js';

const CURRENT_SCHEMA_VERSION = 1;

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

    if (parsed.schemaVersion !== CURRENT_SCHEMA_VERSION) {
      // Future: migrate schema here
    }

    return parsed;
  } catch {
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      imports: {},
    };
  }
}

export function saveRegistry(registry: ImportRegistry): void {
  ensureImportsDir();
  const registryPath = getRegistryPath();
  writeFileSync(registryPath, JSON.stringify(registry, null, 2));
}

export function registerImport(
  repoName: string,
  manifest: ImportManifest,
  source: string
): InstalledImport {
  const registry = loadRegistry();
  const installPath = getImportInstallPath(repoName);
  const resolvedPaths = getResolvedPaths(installPath, manifest);

  const installedImport: InstalledImport = {
    name: manifest.name,
    version: manifest.version,
    source,
    path: installPath,
    installedAt: new Date().toISOString(),
    resolvedPaths,
  };

  registry.imports[manifest.name] = installedImport;
  saveRegistry(registry);

  return installedImport;
}

export function unregisterImport(name: string): boolean {
  const registry = loadRegistry();

  if (!registry.imports[name]) {
    return false;
  }

  delete registry.imports[name];
  saveRegistry(registry);
  return true;
}

export function getInstalledImport(name: string): InstalledImport | undefined {
  const registry = loadRegistry();
  return registry.imports[name];
}

export function getAllInstalledImports(): InstalledImport[] {
  const registry = loadRegistry();
  return Object.values(registry.imports).filter(
    (imp) => existsSync(imp.path) && !!parseManifest(imp.path)
  );
}

export function isImportRegistered(name: string): boolean {
  const registry = loadRegistry();
  return name in registry.imports;
}

export function getImportRoots(): string[] {
  const imports = getAllInstalledImports();
  return imports.map((imp) => imp.path);
}
