/**
 * Registry service — encapsulates all registry CRUD operations.
 *
 * This service is the single point of access for the import registry.
 * No other module should read/write `registry.json` directly.
 */

import type { ImportRegistry, InstalledImport, ImportManifest } from '../types.js';
import { getRegistryPath, ensureImportsDir } from '../paths.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

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

export function getByName(name: string): InstalledImport | undefined {
  return loadRegistry().imports[name];
}

export function getAll(): InstalledImport[] {
  return Object.values(loadRegistry().imports);
}

export function exists(name: string): boolean {
  return name in loadRegistry().imports;
}

export function getRootPaths(): string[] {
  return getAll().map((imp) => imp.path);
}

export function add(installed: InstalledImport): void {
  const registry = loadRegistry();
  registry.imports[installed.name] = installed;
  saveRegistry(registry);
}

export function remove(name: string): boolean {
  const registry = loadRegistry();
  if (!registry.imports[name]) {
    delete registry.imports[name];
    saveRegistry(registry);
    return true;
  }
  return false;
}
