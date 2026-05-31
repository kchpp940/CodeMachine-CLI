/**
 * Manifest validation service.
 *
 * Checks structural correctness of an import directory:
 * manifest file existence, required fields, and expected
 * resource directories / files.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ImportManifest, ValidationResult } from '../types.js';
import { findManifestPath, parseManifest, getResolvedPaths } from '../manifest.js';

export function validateImport(importPath: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const manifest = parseManifest(importPath);
  if (!manifest) {
    const localManifest = '.codemachine.json';
    const standardManifest = 'codemachine.json';
    errors.push(`Missing manifest file (${standardManifest} or ${localManifest})`);
    return { valid: false, errors, warnings };
  }

  const fieldErrors = validateManifestFields(manifest);
  errors.push(...fieldErrors);

  const paths = getResolvedPaths(importPath, manifest);
  const structureErrors = validateDirectoryStructure(importPath, paths);
  errors.push(...structureErrors.errors);
  warnings.push(...structureErrors.warnings);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    manifest,
  };
}

export function validateManifestFields(manifest: ImportManifest): string[] {
  const errors: string[] = [];

  if (!manifest.name || typeof manifest.name !== 'string') {
    errors.push('Manifest missing required "name" field');
  }
  if (!manifest.version || typeof manifest.version !== 'string') {
    errors.push('Manifest missing required "version" field');
  }

  return errors;
}

interface StructureValidationResult {
  errors: string[];
  warnings: string[];
}

export function validateDirectoryStructure(
  importPath: string,
  resolvedPaths: { config: string; workflows: string; prompts: string; characters: string },
): StructureValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!existsSync(resolvedPaths.config)) {
    errors.push(`Missing config directory: ${resolvedPaths.config}`);
  } else {
    const mainAgentsPath = join(resolvedPaths.config, 'main.agents.js');
    if (!existsSync(mainAgentsPath)) {
      errors.push('Missing required file: config/main.agents.js');
    }
  }

  if (!existsSync(resolvedPaths.workflows)) {
    errors.push(`Missing workflows directory: ${resolvedPaths.workflows}`);
  } else {
    const workflowFiles = readdirSync(resolvedPaths.workflows).filter(
      (f) => f.endsWith('.workflow.js'),
    );
    if (workflowFiles.length === 0) {
      errors.push('No .workflow.js files found in workflows directory');
    }
  }

  if (!existsSync(resolvedPaths.prompts)) {
    warnings.push(`Missing prompts directory: ${resolvedPaths.prompts}`);
  }

  return { errors, warnings };
}

export function hasManifestFile(importPath: string): boolean {
  return findManifestPath(importPath) !== null;
}
