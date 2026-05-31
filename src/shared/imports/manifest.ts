/**
 * Manifest parsing for CodeMachine imports.
 *
 * Responsible for locating and reading `codemachine.json` / `.codemachine.json`
 * files. Path resolution delegates to `resolved-paths.service.ts`.
 *
 * Validation logic lives in `services/manifest-validator.service.ts`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImportManifest } from './types.js';
import { resolve as resolvePaths } from './services/resolved-paths.service.js';

const MANIFEST_FILENAME = 'codemachine.json';
const LOCAL_MANIFEST_FILENAME = '.codemachine.json';

export function findManifestPath(importPath: string): string | null {
  const localManifestPath = join(importPath, LOCAL_MANIFEST_FILENAME);
  if (existsSync(localManifestPath)) {
    return localManifestPath;
  }

  const manifestPath = join(importPath, MANIFEST_FILENAME);
  if (existsSync(manifestPath)) {
    return manifestPath;
  }

  return null;
}

export function parseManifest(importPath: string): ImportManifest | null {
  const manifestPath = findManifestPath(importPath);

  if (!manifestPath) {
    return null;
  }

  try {
    const content = readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(content);
    return parsed as ImportManifest;
  } catch {
    return null;
  }
}

export function getResolvedPaths(importPath: string, manifest?: ImportManifest | null): {
  config: string;
  workflows: string;
  prompts: string;
  characters: string;
} {
  return resolvePaths(importPath, manifest);
}

export function getManifestFilename(): string {
  return MANIFEST_FILENAME;
}
