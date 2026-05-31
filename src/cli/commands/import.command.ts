/**
 * Import command for CodeMachine
 *
 * Usage:
 *   codemachine import <source>           Install/update an import
 *   codemachine import --list             List installed imports
 *   codemachine import --remove <name>    Remove an import
 *
 * Source formats:
 *   - Local path: /path/to/folder or ./relative/path (requires .codemachine.json)
 *   - GitHub: package-name, owner/repo, or https://github.com/...
 *   - Git URL: git@github.com:user/repo.git
 */

import type { Command } from 'commander';
import { existsSync, rmSync } from 'node:fs';
import chalk from 'chalk';
import {
  extractRepoName,
  getImportInstallPath,
  unregisterImport,
  getAllInstalledImports,
  getInstalledImport,
  installPackage,
  findBackupDirs,
  loadRegistry,
  scanImportDirs,
  parseManifest,
} from '../../shared/imports/index.js';
import type { ScannedImportDir } from '../../shared/imports/index.js';

interface ImportCommandOptions {
  list?: boolean;
  remove?: boolean;
  verbose?: boolean;
}

async function installImport(source: string, _verbose: boolean): Promise<void> {
  console.log(`\nResolving source: ${source}`);

  const result = await installPackage(source);

  if (result.success) {
    console.log(`\n✅ Successfully installed: ${result.name} v${result.version}`);
    console.log(`   Location: ${result.location}`);
  } else {
    console.error(`\n❌ Installation failed: ${result.error}`);
    if (result.errorDetails) {
      console.error(`   Details: ${result.errorDetails}`);
    }
    if (result.rolledBack) {
      console.log(chalk.yellow('   Previous version has been restored automatically.'));
    }
    throw new Error(result.error);
  }
}

function repoNameFromPath(path: string): string {
  return path.split('/').pop() ?? path;
}

function findRegistryEntryByName(name: string): { name: string; path: string } | null {
  const registry = loadRegistry();
  for (const [regName, imp] of Object.entries(registry.imports)) {
    if (regName === name || imp.path.endsWith(`/${name}`)) {
      return { name: regName, path: imp.path };
    }
  }
  return null;
}

async function removeImport(name: string): Promise<void> {
  console.log(`\nLooking for import or artifacts matching: ${name}`);

  let removedSomething = false;
  let messages: string[] = [];

  // 1. Find by registry entry first
  const regEntry = findRegistryEntryByName(name);
  if (regEntry) {
    const repoName = repoNameFromPath(regEntry.path);

    // Remove main directory
    if (existsSync(regEntry.path)) {
      rmSync(regEntry.path, { recursive: true, force: true });
      messages.push(`Removed main directory: ${regEntry.path}`);
      removedSomething = true;
    }

    // Remove backups for this repo
    const backups = findBackupDirs(repoName);
    for (const backup of backups) {
      rmSync(backup, { recursive: true, force: true });
      messages.push(`Removed backup: ${backup}`);
      removedSomething = true;
    }

    // Remove from registry
    unregisterImport(regEntry.name);
    messages.push(`Unregistered from registry: ${regEntry.name}`);
    removedSomething = true;
  }

  // 2. If no registry entry, try matching by repoName to orphaned backups/broken dirs
  if (!removedSomething) {
    const scanned = scanImportDirs();
    const matching = scanned.filter(
      (d) => d.name === name || d.path.endsWith(`/${name}`)
    );

    for (const dir of matching) {
      rmSync(dir.path, { recursive: true, force: true });
      messages.push(`Removed ${dir.kind} directory: ${dir.path}`);
      removedSomething = true;
    }
  }

  // 3. Also try removing registry orphan if name matches
  if (!removedSomething) {
    const registry = loadRegistry();
    if (registry.imports[name]) {
      unregisterImport(name);
      messages.push(`Removed orphan registry entry: ${name}`);
      removedSomething = true;
    }
  }

  if (!removedSomething) {
    console.error(`\n❌ No import or artifacts found matching: ${name}`);
    console.log('Use "codemachine import --list" to see all imports and artifacts.');
    return;
  }

  for (const msg of messages) {
    console.log(`   ${msg}`);
  }
  console.log(`\n✅ Cleanup complete for: ${name}`);
}

function listImports(): void {
  const registry = loadRegistry();
  const scanned = scanImportDirs();

  // Group by repo name
  const byRepo = new Map<string, {
    complete?: ScannedImportDir;
    backups: ScannedImportDir[];
    broken: ScannedImportDir[];
    temp: ScannedImportDir[];
    registryName?: string;
    registryPath?: string;
    hasRegistryButNoDir: boolean;
  }>();

  // Helper to get or create entry
  const getOrCreate = (repoName: string) => {
    let entry = byRepo.get(repoName);
    if (!entry) {
      entry = { backups: [], broken: [], temp: [], hasRegistryButNoDir: false };
      byRepo.set(repoName, entry);
    }
    return entry;
  };

  // Add scanned directories
  for (const dir of scanned) {
    const repoName = dir.kind === 'complete' ? repoNameFromPath(dir.path) : dir.name;
    const entry = getOrCreate(repoName);

    if (dir.kind === 'complete') {
      entry.complete = dir;
    } else if (dir.kind === 'backup') {
      entry.backups.push(dir);
    } else if (dir.kind === 'broken') {
      entry.broken.push(dir);
    } else if (dir.kind === 'temp') {
      entry.temp.push(dir);
    }
  }

  // Add registry entries and detect orphans
  for (const [regName, imp] of Object.entries(registry.imports)) {
    const repoName = repoNameFromPath(imp.path);
    const entry = getOrCreate(repoName);
    entry.registryName = regName;
    entry.registryPath = imp.path;

    // Check if path exists with manifest (registry orphan if not)
    if (!existsSync(imp.path) || !parseManifest(imp.path)) {
      entry.hasRegistryButNoDir = true;
    }
  }

  // If nothing at all, show help
  if (byRepo.size === 0) {
    console.log('\nNo imports or artifacts found.');
    console.log(`\nTo install an import, use:`);
    console.log(`  codemachine import <package-name>`);
    console.log(`  codemachine import <owner>/<repo>`);
    console.log(`  codemachine import <https://github.com/...>`);
    console.log(`  codemachine import </path/to/folder>  (local with .codemachine.json)`);
    return;
  }

  // Render
  console.log('\nImports and artifacts:\n');

  let completeCount = 0;
  let problemCount = 0;

  byRepo.forEach((entry, repoName) => {
    const manifest = entry.complete ? parseManifest(entry.complete.path) : null;
    const displayName = entry.registryName ?? manifest?.name ?? repoName;

    if (entry.complete && manifest) {
      completeCount++;
      console.log(`  ${chalk.green(displayName)} ${manifest.version ? `v${manifest.version}` : ''}`);
      console.log(`    Path: ${entry.complete.path}`);
    } else if (entry.registryName) {
      problemCount++;
      console.log(`  ${chalk.red(displayName)} (registry entry only — directory missing/corrupted)`);
      console.log(`    Path: ${entry.registryPath}`);
      console.log(chalk.red('    ⚠  Registry entry exists but directory has no valid manifest'));
    }

    if (entry.backups.length > 0) {
      problemCount++;
      console.log(chalk.yellow(`    ⚠  ${entry.backups.length} recoverable backup(s) from failed update:`));
      for (const b of entry.backups) {
        console.log(chalk.yellow(`       ${b.path}`));
      }
    }

    if (entry.broken.length > 0) {
      problemCount++;
      console.log(chalk.red(`    ⚠  ${entry.broken.length} incomplete/broken directory(ies):`));
      for (const b of entry.broken) {
        console.log(chalk.red(`       ${b.path}`));
      }
    }

    if (entry.temp.length > 0) {
      problemCount++;
      console.log(chalk.gray(`    ⚠  ${entry.temp.length} stale temp directory(ies):`));
      for (const t of entry.temp) {
        console.log(chalk.gray(`       ${t.path}`));
      }
    }

    console.log('');
  });

  const summaryParts: string[] = [`${completeCount} complete`];
  if (problemCount > 0) summaryParts.push(`${problemCount} with issue(s)`);
  console.log(`Total: ${summaryParts.join(', ')}`);

  if (problemCount > 0) {
    console.log(chalk.yellow('\n💡 Tip: Use "codemachine import --remove <name>" to clean up broken artifacts.'));
  }
}

async function runImportCommand(
  source: string | undefined,
  options: ImportCommandOptions
): Promise<void> {
  try {
    if (options.list) {
      listImports();
      return;
    }

    if (options.remove) {
      if (!source) {
        console.error('❌ Please specify an import to remove.');
        console.log('Usage: codemachine import --remove <name>');
        return;
      }
      await removeImport(source);
      return;
    }

    if (!source) {
      console.error('❌ Please specify a source to import.');
      console.log('\nUsage:');
      console.log(`  codemachine import <package-name>`);
      console.log(`  codemachine import <owner>/<repo>`);
      console.log(`  codemachine import <https://github.com/...>`);
      console.log(`  codemachine import </path/to/folder>   (local path with .codemachine.json)`);
      console.log(`  codemachine import <./relative/path>   (local path with .codemachine.json)`);
      console.log('\nOther options:');
      console.log('  codemachine import --list            List installed imports');
      console.log('  codemachine import --remove <name>   Remove an import');
      return;
    }

    await installImport(source, options.verbose ?? false);
  } catch (error) {
    console.error(
      '\n❌ Error:',
      error instanceof Error ? error.message : String(error)
    );
    process.exitCode = 1;
  }
}

export function registerImportCommand(program: Command): void {
  program
    .command('import [source]')
    .description('Import external workflow packages')
    .option('-l, --list', 'List installed imports')
    .option('-r, --remove', 'Remove an import')
    .option('-v, --verbose', 'Verbose output')
    .action(async (source: string | undefined, options: ImportCommandOptions) => {
      await runImportCommand(source, options);
    });
}
