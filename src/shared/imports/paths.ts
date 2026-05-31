/**
 * Base path resolution — INTERNAL USE ONLY.
 *
 * @internal
 *
 * External code MUST NOT import from this file directly.
 * Use the public API in `./index.js` instead.
 *
 * Home directory resolution lives here. Install-specific paths
 * (install, temp, backup) are computed by `services/path.service.ts`.
 *
 * This file re-exports path service functions for backward compatibility
 * with internal code that has not yet been updated.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export {
  getInstallPath as getImportInstallPath,
  isInstalled as isImportInstalled,
  listInstalledDirectories as getInstalledImportPaths,
} from './services/path.service.js';

export function getCodemachineHomeDir(): string {
  const override = process.env.CODEMACHINE_HOME;
  if (override && override.length > 0) return override;
  return join(homedir(), '.codemachine');
}

export function getImportsDir(): string {
  const override = process.env.CODEMACHINE_IMPORTS_DIR;
  if (override && override.length > 0) return override;
  return join(getCodemachineHomeDir(), 'imports');
}

export function getRegistryPath(): string {
  return join(getImportsDir(), 'registry.json');
}

export function ensureImportsDir(): string {
  const importsDir = getImportsDir();
  if (!existsSync(importsDir)) {
    mkdirSync(importsDir, { recursive: true });
  }
  return importsDir;
}
