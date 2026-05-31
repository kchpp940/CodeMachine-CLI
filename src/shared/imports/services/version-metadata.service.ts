/**
 * Version metadata service.
 *
 * Fetches remote manifest versions and compares with the
 * locally installed version to determine whether an update
 * is available.
 */

import type { InstalledImport } from '../types.js';
import { getInstalledImport } from '../registry.js';

export interface RemoteVersionInfo {
  version: string | null;
  error?: string;
}

export async function fetchRemoteVersion(
  manifestUrl: string,
  timeoutMs = 10_000,
): Promise<RemoteVersionInfo> {
  try {
    const response = await fetch(manifestUrl, {
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      return { version: null, error: `HTTP ${response.status}` };
    }

    let remoteManifest: { version?: string };
    try {
      remoteManifest = (await response.json()) as { version?: string };
    } catch {
      return { version: null, error: 'Invalid JSON in manifest' };
    }

    const remoteVersion = remoteManifest?.version;
    if (!remoteVersion) {
      return { version: null, error: 'Remote manifest has no version field' };
    }

    return { version: remoteVersion };
  } catch (err) {
    return {
      version: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function isUpdateAvailable(
  packageName: string,
  manifestUrl: string,
  timeoutMs?: number,
): Promise<boolean> {
  const installed = getInstalledImport(packageName);
  if (!installed) return false;

  const remote = await fetchRemoteVersion(manifestUrl, timeoutMs);
  if (!remote.version) return false;

  return remote.version !== installed.version;
}

export function getInstalledVersion(packageName: string): string | null {
  const installed = getInstalledImport(packageName);
  return installed?.version ?? null;
}

export function getInstalledMetadata(packageName: string): InstalledImport | null {
  return getInstalledImport(packageName) ?? null;
}
