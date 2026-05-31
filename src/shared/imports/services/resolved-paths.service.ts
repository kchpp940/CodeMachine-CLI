/**
 * Resolved paths service — assembles resolved resource paths from manifest overrides.
 *
 * Given an install path and (optionally a manifest, returns the
 * concrete paths to config/workflows/prompts/characters resources.
 */

import { join } from 'node:path';
import type { ImportManifest } from '../types.js';

const DEFAULT_PATHS = {
  config: 'config',
  workflows: 'templates/workflows',
  prompts: 'prompts',
  characters: 'config/agent-characters.json',
};

export function resolve(importPath: string, manifest?: ImportManifest | null): {
  config: string;
  workflows: string;
  prompts: string;
  characters: string;
} {
  const paths = manifest?.paths ?? {};

  return {
    config: join(importPath, paths.config ?? DEFAULT_PATHS.config),
    workflows: join(importPath, paths.workflows ?? DEFAULT_PATHS.workflows),
    prompts: join(importPath, paths.prompts ?? DEFAULT_PATHS.prompts),
    characters: join(importPath, paths.characters ?? DEFAULT_PATHS.characters),
  };
}

export { resolve as resolvePaths };
