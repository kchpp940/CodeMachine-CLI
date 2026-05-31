/**
 * Registry management — INTERNAL USE ONLY.
 *
 * @internal
 *
 * External code MUST NOT import from this file directly.
 * Use the public API in `./index.js` instead.
 *
 * All registry CRUD operations are encapsulated in the registry service.
 * This file re-exports registry service functions for backward compatibility
 * with internal code that has not yet been updated.
 */

export {
  loadRegistry,
  saveRegistry,
  getByName as getInstalledImport,
  getAll as getAllInstalledImports,
  exists as isImportRegistered,
  getRootPaths as getImportRoots,
} from './services/registry.service.js';

import type { ImportManifest } from './types.js';
import type { InstalledImport } from './types.js';
import {
  loadRegistry,
  saveRegistry,
  add as addToRegistry,
} from './services/registry.service.js';
import { getInstallPath } from './services/path.service.js';
import { resolve as resolvePaths } from './services/resolved-paths.service.js';

export function registerImport(
  repoName: string,
  manifest: ImportManifest,
  source: string,
): InstalledImport {
  const installPath = getInstallPath(repoName);
  const resolvedPaths = resolvePaths(installPath, manifest);

  const installedImport: InstalledImport = {
    name: manifest.name,
    version: manifest.version,
    source,
    path: installPath,
    installedAt: new Date().toISOString(),
    resolvedPaths,
  };

  addToRegistry(installedImport);
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
