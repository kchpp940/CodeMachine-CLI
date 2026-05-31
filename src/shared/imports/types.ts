/**
 * Type definitions for the CodeMachine import system
 */

/**
 * Manifest file structure (codemachine.json)
 * Minimal by default, with optional path overrides
 */
export interface ImportManifest {
  /** Package name (required) */
  name: string;
  /** Package version (required) */
  version: string;
  /** Optional description */
  description?: string;
  /** Optional custom paths (defaults to convention) */
  paths?: {
    /** Config directory (default: 'config/') */
    config?: string;
    /** Workflows directory (default: 'templates/workflows/') */
    workflows?: string;
    /** Prompts directory (default: 'prompts/') */
    prompts?: string;
    /** Agent characters file (default: 'config/agent-characters.json') */
    characters?: string;
  };
}

/**
 * Version resolution strategy when re-installing an import:
 * - 'pin': Fixed to a specific commit/tag/branch (stored in pinnedRef)
 * - 'update': Always pull the latest version from source
 * - 'keep': Keep the currently installed version, don't modify registry
 */
export type VersionStrategy = 'pin' | 'update' | 'keep';

/**
 * Result of source consistency check
 */
export interface SourceConsistencyCheck {
  isConsistent: boolean;
  existingSource?: string;
  newSource?: string;
  message: string;
}

/**
 * Metadata about an installed import
 */
export interface InstalledImport {
  /** Package name from manifest */
  name: string;
  /** Package version from manifest */
  version: string;
  /** Original source string used for installation */
  source: string;
  /** Resolved source URL (git URL or local path) */
  sourceUrl: string;
  /** Type of source */
  sourceType: 'github-search' | 'github-repo' | 'git-url' | 'local-path';
  /** Repository owner (for GitHub repos) */
  owner?: string;
  /** Repository name (folder name on disk) */
  repoName: string;
  /** Digest/hash representing the source content state
   * - For git sources: git commit hash (7 chars)
   * - For local git dirs: git commit hash
   * - For local non-git: content hash of manifest + file listing
   */
  sourceDigest?: string;
  /** Digest type to help interpret sourceDigest */
  digestType?: 'git-commit' | 'content-hash';
  /** Pinned reference (commit/tag/branch) when strategy is 'pin' */
  pinnedRef?: string;
  /** Absolute path to installed location */
  path: string;
  /** When the import was installed */
  installedAt: string;
  /** Last time the import was updated */
  updatedAt?: string;
  /** Version strategy for future updates */
  versionStrategy?: VersionStrategy;
  /** Resolved paths to resources */
  resolvedPaths: {
    config: string;
    workflows: string;
    prompts: string;
    characters: string;
  };
}

/**
 * Registry file structure (~/.codemachine/imports/registry.json)
 */
export interface ImportRegistry {
  /** Schema version for future migrations */
  schemaVersion: number;
  /** Map of package name to installed import info */
  imports: Record<string, InstalledImport>;
}

/**
 * Result of resolving an import source
 */
export interface ResolvedSource {
  /** Type of resolution */
  type: 'github-search' | 'github-repo' | 'git-url' | 'local-path';
  /** Full URL to clone (or absolute path for local) */
  url: string;
  /** Repository name (folder name) */
  repoName: string;
  /** Owner (for GitHub repos) */
  owner?: string;
}

/**
 * Import command options
 */
export interface ImportOptions {
  /** Remove the import instead of installing */
  remove?: boolean;
  /** List installed imports */
  list?: boolean;
  /** Verbose output */
  verbose?: boolean;
  /** Pin to a specific commit/tag/branch (e.g., --pin v1.0.0 or --pin a1b2c3d) */
  pin?: string;
  /** Keep current version, don't modify registry or files */
  keep?: boolean;
  /** Force update to latest version from source */
  update?: boolean;
  /** Force rebind to a different source (bypasses source consistency check) */
  force?: boolean;
}

/**
 * Validation result for an import
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  manifest?: ImportManifest;
}
