/**
 * Import-aware path resolution utilities
 *
 * These utilities help resolve paths by checking both local directories
 * and imported packages. Local project takes precedence over imports.
 */

import { existsSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { getAllInstalledImports } from './registry.js';
import type { InstalledImport } from './types.js';
import { otel_debug, otel_warn } from '../logging/logger.js';
import { LOGGER_NAMES } from '../logging/otel-logger.js';

/**
 * Result of path resolution with conflict detection
 */
export interface ResolveResult {
  /** Resolved absolute path, or null if not found */
  path: string | null;
  /** Source of the resolved path */
  source: 'local' | 'import' | 'absolute' | null;
  /** Import that provided the path, if source is 'import' */
  import?: InstalledImport;
  /** Conflicting paths found in other sources */
  conflicts: Array<{
    path: string;
    source: 'local' | 'import';
    import?: InstalledImport;
  }>;
  /** All candidate paths that were checked (for error messages) */
  checkedPaths: string[];
}

/**
 * Check for conflicts between local and import paths
 */
function findConflicts(
  targetPath: string,
  localPath: string | null,
  imports: InstalledImport[],
  checkImportPath: (imp: InstalledImport) => string | null
): ResolveResult['conflicts'] {
  const conflicts: ResolveResult['conflicts'] = [];

  if (localPath && existsSync(localPath) && resolve(localPath) !== resolve(targetPath)) {
    conflicts.push({ path: localPath, source: 'local' });
  }

  for (const imp of imports) {
    const importPath = checkImportPath(imp);
    if (importPath && existsSync(importPath) && resolve(importPath) !== resolve(targetPath)) {
      conflicts.push({ path: importPath, source: 'import', import: imp });
    }
  }

  return conflicts;
}

/**
 * Log conflict warnings
 */
function logConflicts(
  resourceType: string,
  resourceName: string,
  chosenPath: string,
  chosenSource: string,
  conflicts: ResolveResult['conflicts']
): void {
  if (conflicts.length === 0) return;

  const conflictDescriptions = conflicts.map(c =>
    c.source === 'import' && c.import
      ? `${c.import.name} (${c.path})`
      : `local project (${c.path})`
  ).join(', ');

  otel_warn(
    LOGGER_NAMES.CLI,
    '[resolve] %s "%s" has conflicting definitions. Using %s: %s. Also found in: %s',
    [resourceType, resourceName, chosenSource, chosenPath, conflictDescriptions]
  );

  console.warn(
    `Warning: ${resourceType} "${resourceName}" has conflicting definitions.\n` +
    `  Using ${chosenSource}: ${chosenPath}\n` +
    `  Also found in: ${conflictDescriptions}\n` +
    `  Consider renaming your local ${resourceType} to avoid ambiguity.`
  );
}

/**
 * Resolve a prompt path by checking local first, then imported packages
 * Local project takes precedence over imports.
 *
 * @param relativePath - Relative path like "prompts/templates/foo/bar.md" or "foo/bar.md"
 * @param localRoot - Local root directory to check (e.g., packageRoot or cwd)
 * @returns ResolveResult with path, source, conflict info, and checked paths
 */
export function resolvePromptPath(relativePath: string, localRoot: string): ResolveResult {
  const result: ResolveResult = {
    path: null,
    source: null,
    conflicts: [],
    checkedPaths: [],
  };

  if (isAbsolute(relativePath)) {
    const absolutePath = resolve(relativePath);
    result.checkedPaths.push(absolutePath);
    if (existsSync(absolutePath)) {
      result.path = absolutePath;
      result.source = 'absolute';
    }
    return result;
  }

  const imports = getAllInstalledImports();

  const localCandidates = [
    resolve(localRoot, relativePath),
  ];

  if (!relativePath.startsWith('prompts/')) {
    localCandidates.push(resolve(localRoot, 'prompts', 'templates', relativePath));
  }

  let localPath: string | null = null;
  for (const candidate of localCandidates) {
    result.checkedPaths.push(candidate);
    if (existsSync(candidate)) {
      localPath = candidate;
      break;
    }
  }

  const importPaths = new Map<InstalledImport, string>();
  for (const imp of imports) {
    let importPath: string | null = null;

    if (relativePath.startsWith('prompts/')) {
      const subPath = relativePath.replace(/^prompts\//, '');
      importPath = join(imp.resolvedPaths.prompts, subPath.replace(/^templates\//, ''));
    } else {
      importPath = join(imp.resolvedPaths.prompts, relativePath);
    }

    if (importPath) {
      result.checkedPaths.push(importPath);
      if (existsSync(importPath)) {
        importPaths.set(imp, importPath);
      }
    }

    const directPath = join(imp.path, relativePath);
    result.checkedPaths.push(directPath);
    if (!importPath || resolve(importPath) !== resolve(directPath)) {
      if (existsSync(directPath) && !importPaths.has(imp)) {
        importPaths.set(imp, directPath);
      }
    }
  }

  if (localPath) {
    result.path = localPath;
    result.source = 'local';
    result.conflicts = findConflicts(
      localPath,
      null,
      imports,
      (imp) => importPaths.get(imp) || null
    );
    logConflicts('Prompt', relativePath, localPath, 'local project', result.conflicts);
    otel_debug(LOGGER_NAMES.CLI, '[resolve] Found prompt in local: %s', [localPath]);
    return result;
  }

  if (importPaths.size > 0) {
    const [firstImport, firstPath] = importPaths.entries().next().value as [InstalledImport, string];
    result.path = firstPath;
    result.source = 'import';
    result.import = firstImport;

    const otherImports = Array.from(importPaths.entries()).filter(([imp]) => imp !== firstImport);
    for (const [imp, path] of otherImports) {
      result.conflicts.push({ path, source: 'import', import: imp });
    }

    if (result.conflicts.length > 0) {
      logConflicts('Prompt', relativePath, firstPath, `import ${firstImport.name}`, result.conflicts);
    }

    otel_debug(LOGGER_NAMES.CLI, '[resolve] Found prompt in import %s: %s', [firstImport.name, firstPath]);
    return result;
  }

  return result;
}

/**
 * Resolve a prompt folder path by checking local first, then imported packages
 * Local project takes precedence over imports.
 *
 * @param folderName - Folder name like "bmad" (will look in prompts/templates/bmad)
 * @param localRoot - Local root directory to check
 * @returns ResolveResult with path, source, conflict info, and checked paths
 */
export function resolvePromptFolder(folderName: string, localRoot: string): ResolveResult {
  const result: ResolveResult = {
    path: null,
    source: null,
    conflicts: [],
    checkedPaths: [],
  };

  const imports = getAllInstalledImports();

  const localPath = resolve(localRoot, 'prompts', 'templates', folderName);
  result.checkedPaths.push(localPath);

  const importPaths = new Map<InstalledImport, string>();
  for (const imp of imports) {
    const importPath = join(imp.resolvedPaths.prompts, folderName);
    result.checkedPaths.push(importPath);
    if (existsSync(importPath)) {
      importPaths.set(imp, importPath);
    }
  }

  if (existsSync(localPath)) {
    result.path = localPath;
    result.source = 'local';
    result.conflicts = findConflicts(
      localPath,
      null,
      imports,
      (imp) => importPaths.get(imp) || null
    );
    logConflicts('Prompt folder', folderName, localPath, 'local project', result.conflicts);
    otel_debug(LOGGER_NAMES.CLI, '[resolve] Found prompt folder in local: %s', [localPath]);
    return result;
  }

  if (importPaths.size > 0) {
    const [firstImport, firstPath] = importPaths.entries().next().value as [InstalledImport, string];
    result.path = firstPath;
    result.source = 'import';
    result.import = firstImport;

    const otherImports = Array.from(importPaths.entries()).filter(([imp]) => imp !== firstImport);
    for (const [imp, path] of otherImports) {
      result.conflicts.push({ path, source: 'import', import: imp });
    }

    if (result.conflicts.length > 0) {
      logConflicts('Prompt folder', folderName, firstPath, `import ${firstImport.name}`, result.conflicts);
    }

    otel_debug(LOGGER_NAMES.CLI, '[resolve] Found prompt folder in import %s: %s', [firstImport.name, firstPath]);
    return result;
  }

  return result;
}

/**
 * Resolve a workflow template path by checking local first, then imported packages
 * Local project takes precedence over imports.
 *
 * @param templateName - Template filename like "codemachine-one.workflow.js"
 * @param localRoot - Local root directory to check
 * @returns ResolveResult with path, source, conflict info, and checked paths
 */
export function resolveWorkflowTemplate(templateName: string, localRoot: string): ResolveResult {
  const result: ResolveResult = {
    path: null,
    source: null,
    conflicts: [],
    checkedPaths: [],
  };

  if (isAbsolute(templateName)) {
    const absolutePath = resolve(templateName);
    result.checkedPaths.push(absolutePath);
    if (existsSync(absolutePath)) {
      result.path = absolutePath;
      result.source = 'absolute';
    }
    return result;
  }

  const imports = getAllInstalledImports();

  const localCandidates = [
    resolve(localRoot, 'templates', 'workflows', templateName),
    resolve(localRoot, templateName),
  ];

  let localPath: string | null = null;
  for (const candidate of localCandidates) {
    result.checkedPaths.push(candidate);
    if (existsSync(candidate)) {
      localPath = candidate;
      break;
    }
  }

  const importPaths = new Map<InstalledImport, string>();
  for (const imp of imports) {
    const importPath = join(imp.resolvedPaths.workflows, templateName);
    result.checkedPaths.push(importPath);
    if (existsSync(importPath)) {
      importPaths.set(imp, importPath);
    }

    const directPath = join(imp.path, templateName);
    result.checkedPaths.push(directPath);
    if (resolve(importPath) !== resolve(directPath)) {
      if (existsSync(directPath) && !importPaths.has(imp)) {
        importPaths.set(imp, directPath);
      }
    }
  }

  if (localPath) {
    result.path = localPath;
    result.source = 'local';
    result.conflicts = findConflicts(
      localPath,
      null,
      imports,
      (imp) => importPaths.get(imp) || null
    );
    logConflicts('Workflow template', templateName, localPath, 'local project', result.conflicts);
    otel_debug(LOGGER_NAMES.CLI, '[resolve] Found workflow template in local: %s', [localPath]);
    return result;
  }

  if (importPaths.size > 0) {
    const [firstImport, firstPath] = importPaths.entries().next().value as [InstalledImport, string];
    result.path = firstPath;
    result.source = 'import';
    result.import = firstImport;

    const otherImports = Array.from(importPaths.entries()).filter(([imp]) => imp !== firstImport);
    for (const [imp, path] of otherImports) {
      result.conflicts.push({ path, source: 'import', import: imp });
    }

    if (result.conflicts.length > 0) {
      logConflicts('Workflow template', templateName, firstPath, `import ${firstImport.name}`, result.conflicts);
    }

    otel_debug(LOGGER_NAMES.CLI, '[resolve] Found workflow template in import %s: %s', [firstImport.name, firstPath]);
    return result;
  }

  return result;
}

/**
 * Resolve a path by checking local first, then additional roots, then imports
 * Local project takes precedence over imports.
 *
 * @param relativePath - Relative path to resolve
 * @param localRoot - Local root directory
 * @param additionalRoots - Additional roots to check
 * @returns ResolveResult with path, source, conflict info, and checked paths
 */
export function resolvePathWithImports(
  relativePath: string,
  localRoot: string,
  additionalRoots: string[] = []
): ResolveResult {
  const result: ResolveResult = {
    path: null,
    source: null,
    conflicts: [],
    checkedPaths: [],
  };

  if (isAbsolute(relativePath)) {
    const absolutePath = resolve(relativePath);
    result.checkedPaths.push(absolutePath);
    if (existsSync(absolutePath)) {
      result.path = absolutePath;
      result.source = 'absolute';
    }
    return result;
  }

  const imports = getAllInstalledImports();

  const localPath = resolve(localRoot, relativePath);
  result.checkedPaths.push(localPath);

  const additionalPaths: string[] = [];
  for (const root of additionalRoots) {
    const path = resolve(root, relativePath);
    result.checkedPaths.push(path);
    additionalPaths.push(path);
  }

  const importPaths = new Map<InstalledImport, string>();
  for (const imp of imports) {
    const importPath = join(imp.path, relativePath);
    result.checkedPaths.push(importPath);
    if (existsSync(importPath)) {
      importPaths.set(imp, importPath);
    }
  }

  if (existsSync(localPath)) {
    result.path = localPath;
    result.source = 'local';
    result.conflicts = findConflicts(
      localPath,
      null,
      imports,
      (imp) => importPaths.get(imp) || null
    );
    for (const addPath of additionalPaths) {
      if (existsSync(addPath) && resolve(addPath) !== resolve(localPath)) {
        result.conflicts.push({ path: addPath, source: 'local' });
      }
    }
    if (result.conflicts.length > 0) {
      logConflicts('Path', relativePath, localPath, 'local project', result.conflicts);
    }
    otel_debug(LOGGER_NAMES.CLI, '[resolve] Found path in local: %s', [localPath]);
    return result;
  }

  for (const addPath of additionalPaths) {
    if (existsSync(addPath)) {
      result.path = addPath;
      result.source = 'local';
      result.conflicts = findConflicts(
        addPath,
        null,
        imports,
        (imp) => importPaths.get(imp) || null
      );
      if (result.conflicts.length > 0) {
        logConflicts('Path', relativePath, addPath, 'additional root', result.conflicts);
      }
      otel_debug(LOGGER_NAMES.CLI, '[resolve] Found path in additional root: %s', [addPath]);
      return result;
    }
  }

  if (importPaths.size > 0) {
    const [firstImport, firstPath] = importPaths.entries().next().value as [InstalledImport, string];
    result.path = firstPath;
    result.source = 'import';
    result.import = firstImport;

    const otherImports = Array.from(importPaths.entries()).filter(([imp]) => imp !== firstImport);
    for (const [imp, path] of otherImports) {
      result.conflicts.push({ path, source: 'import', import: imp });
    }

    if (result.conflicts.length > 0) {
      logConflicts('Path', relativePath, firstPath, `import ${firstImport.name}`, result.conflicts);
    }

    otel_debug(LOGGER_NAMES.CLI, '[resolve] Found path in import %s: %s', [firstImport.name, firstPath]);
    return result;
  }

  return result;
}

/**
 * Get all workflow directories including imports
 * Local directories are listed first (take precedence)
 *
 * @param localRoot - Local root directory
 * @returns Array of absolute paths to workflow directories, local first
 */
export function getAllWorkflowDirectories(localRoot: string): string[] {
  const dirs: string[] = [];

  const localDir = resolve(localRoot, 'templates', 'workflows');
  if (existsSync(localDir)) {
    dirs.push(localDir);
  }

  const imports = getAllInstalledImports();
  for (const imp of imports) {
    if (existsSync(imp.resolvedPaths.workflows)) {
      dirs.push(imp.resolvedPaths.workflows);
    }
  }

  return dirs;
}

/**
 * Get all prompt directories including imports
 * Local directories are listed first (take precedence)
 *
 * @param localRoot - Local root directory
 * @returns Array of absolute paths to prompt directories, local first
 */
export function getAllPromptDirectories(localRoot: string): string[] {
  const dirs: string[] = [];

  const localDir = resolve(localRoot, 'prompts', 'templates');
  if (existsSync(localDir)) {
    dirs.push(localDir);
  }

  const imports = getAllInstalledImports();
  for (const imp of imports) {
    if (existsSync(imp.resolvedPaths.prompts)) {
      dirs.push(imp.resolvedPaths.prompts);
    }
  }

  return dirs;
}

/**
 * Helper to extract just the path from a ResolveResult for backward compatibility
 * @param result - ResolveResult object
 * @returns The resolved path or null
 */
export function getResolvedPath(result: ResolveResult): string | null {
  return result.path;
}

/**
 * Format checked paths for error messages
 * @param checkedPaths - Array of checked paths
 * @returns Formatted string listing all checked paths
 */
export function formatCheckedPaths(checkedPaths: string[]): string {
  if (checkedPaths.length === 0) return ' (no paths checked)';
  return '\n  Checked paths:\n    - ' + checkedPaths.join('\n    - ');
}
