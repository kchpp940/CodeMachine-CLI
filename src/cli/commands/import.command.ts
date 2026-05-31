/**
 * Import command for CodeMachine
 *
 * Usage:
 *   codemachine import <source>                 Install/update an import
 *   codemachine import --list                   List installed imports
 *   codemachine import --remove <name>          Remove an import
 *   codemachine import --update <name>          Update an installed import
 *
 * Version strategies:
 *   --pin <ref>    Pin to a specific commit/tag/branch (e.g., --pin v1.0.0)
 *   --keep         Keep current version, don't modify files or registry
 *   --update       Force update to latest version from source (default)
 *
 * Source rebinding:
 *   --force        Force rebind to a different source (bypasses consistency check)
 *
 * Source formats:
 *   - Local path: /path/to/folder or ./relative/path (requires .codemachine.json)
 *   - GitHub: package-name, owner/repo, or https://github.com/...
 *   - Git URL: git@github.com:user/repo.git
 */

import type { Command } from 'commander';
import { existsSync, rmSync } from 'node:fs';
import {
  installPackage,
  updatePackage,
  unregisterImport,
  getAllInstalledImports,
  getInstalledImport,
  updateImportVersionStrategy,
} from '../../shared/imports/index.js';
import type { InstallPackageOptions } from '../../shared/imports/installer.js';

interface ImportCommandOptions {
  list?: boolean;
  remove?: boolean;
  update?: boolean;
  verbose?: boolean;
  pin?: string;
  keep?: boolean;
  force?: boolean;
}

/**
 * Determine install options from command options
 */
function getInstallOptions(options: ImportCommandOptions): InstallPackageOptions {
  if (typeof options.pin === 'string') {
    return { versionStrategy: 'pin', pinRef: options.pin, forceRebind: options.force };
  }
  if (options.keep) {
    return { versionStrategy: 'keep', forceRebind: options.force };
  }
  return { versionStrategy: 'update', forceRebind: options.force };
}

/**
 * Remove an installed import
 */
async function removeImport(name: string): Promise<void> {
  let installed = getInstalledImport(name);

  if (!installed) {
    const allImports = getAllInstalledImports();
    installed = allImports.find(
      (imp) => imp.repoName === name || imp.path.endsWith(`/${name}`)
    );
  }

  if (!installed) {
    console.error(`\n❌ Import not found: ${name}`);
    console.log('\nUse "codemachine import --list" to see installed imports.');
    return;
  }

  console.log(`\nRemoving: ${installed.name}`);

  if (existsSync(installed.path)) {
    rmSync(installed.path, { recursive: true, force: true });
  }

  unregisterImport(installed.name);

  console.log(`✅ Successfully removed: ${installed.name}`);
}

/**
 * Update an installed import
 */
async function updateImport(name: string, verbose: boolean = false): Promise<void> {
  console.log(`\nUpdating: ${name}`);

  const result = await updatePackage(name);

  if (!result.success) {
    console.error(`\n❌ Update failed: ${result.error}`);
    if (result.errorDetails) {
      console.error(`   ${result.errorDetails}`);
    }
    process.exitCode = 1;
    return;
  }

  if (result.skipped) {
    console.log(`✅ Already up to date: ${result.name} v${result.version}`);
  } else if (result.previousVersion && result.previousVersion !== result.newVersion) {
    console.log(`✅ Updated: ${result.name} v${result.previousVersion} → v${result.newVersion}`);
  } else {
    console.log(`✅ Updated: ${result.name} v${result.version}`);
  }

  if (result.sourceDigest && verbose) {
    const typeLabel = result.digestType === 'content-hash' ? ' (content)' : '';
    console.log(`   Digest: ${result.sourceDigest}${typeLabel}`);
  }
  console.log(`   Location: ${result.location}`);
}

/**
 * List all installed imports with detailed information
 */
function listImports(verbose: boolean = false): void {
  const imports = getAllInstalledImports();

  if (imports.length === 0) {
    console.log('\nNo imports installed.');
    console.log(`\nTo install an import, use:`);
    console.log(`  codemachine import <package-name>`);
    console.log(`  codemachine import <owner>/<repo>`);
    console.log(`  codemachine import <https://github.com/...>`);
    console.log(`  codemachine import </path/to/folder>  (local with .codemachine.json)`);
    return;
  }

  console.log('\nInstalled imports:\n');

  for (const imp of imports) {
    let statusLabel = '';
    if (imp.versionStrategy === 'pin' && imp.pinnedRef) {
      const digestInfo = imp.sourceDigest ? ` → ${imp.sourceDigest}` : '';
      statusLabel = ` [pinned: ${imp.pinnedRef}${digestInfo}]`;
    } else if (imp.versionStrategy === 'pin') {
      statusLabel = imp.sourceDigest ? ` [pinned @ ${imp.sourceDigest}]` : ' [pinned]';
    } else if (imp.versionStrategy === 'keep') {
      statusLabel = ' [keep]';
    }

    console.log(`  ${imp.name} v${imp.version}${statusLabel}`);
    console.log(`    Source: ${imp.source}`);
    console.log(`    Type: ${imp.sourceType}`);

    if (verbose) {
      console.log(`    Source URL: ${imp.sourceUrl}`);
      if (imp.owner) {
        console.log(`    Owner: ${imp.owner}`);
      }
      console.log(`    Repo: ${imp.repoName}`);
      if (imp.sourceDigest) {
        const typeLabel = imp.digestType === 'content-hash' ? ' (content)' : '';
        console.log(`    Source digest: ${imp.sourceDigest}${typeLabel}`);
      }
      if (imp.pinnedRef) {
        console.log(`    Pinned ref: ${imp.pinnedRef}`);
      }
      if (imp.versionStrategy) {
        console.log(`    Strategy: ${imp.versionStrategy}`);
      }
    } else {
      if (imp.sourceDigest && imp.versionStrategy !== 'pin') {
        const typeLabel = imp.digestType === 'content-hash' ? ' (content)' : '';
        console.log(`    Digest: ${imp.sourceDigest}${typeLabel}`);
      }
    }

    console.log(`    Path: ${imp.path}`);
    console.log(`    Installed: ${new Date(imp.installedAt).toLocaleString()}`);

    if (imp.updatedAt) {
      console.log(`    Last updated: ${new Date(imp.updatedAt).toLocaleString()}`);
    }

    console.log('');
  }

  console.log(`Total: ${imports.length} import(s)`);
}

/**
 * Install an import from a source
 */
async function installImport(
  source: string,
  options: ImportCommandOptions
): Promise<void> {
  const installOpts = getInstallOptions(options);
  const { versionStrategy, pinRef } = installOpts;

  const strategyLabel = versionStrategy !== 'update'
    ? ` (strategy: ${versionStrategy}${pinRef ? ` @ ${pinRef}` : ''})`
    : '';

  console.log(`\nInstalling: ${source}${strategyLabel}`);

  if (options.verbose) {
    console.log(`  Version strategy: ${versionStrategy}`);
    if (pinRef) {
      console.log(`  Pin ref: ${pinRef}`);
    }
  }

  const result = await installPackage(source, installOpts);

  if (!result.success) {
    console.error(`\n❌ Installation failed: ${result.error}`);
    if (result.errorDetails) {
      console.error(`   ${result.errorDetails}`);
    }
    process.exitCode = 1;
    return;
  }

  if (result.skipped) {
    let reason = 'unknown reason';
    switch (result.skippedReason) {
      case 'keep-strategy':
        reason = 'keep strategy - no changes';
        break;
      case 'already-at-ref':
        reason = 'already at pinned digest';
        break;
      case 'already-installed':
        reason = 'already installed';
        break;
    }
    console.log(`✅ Skipped (${reason}): ${result.name} v${result.version}`);
    if (result.pinnedRef) {
      const digestInfo = result.sourceDigest ? ` (resolved: ${result.sourceDigest})` : '';
      console.log(`   Pinned: ${result.pinnedRef}${digestInfo}`);
    }
    return;
  }

  if (result.previousVersion && result.previousVersion !== result.newVersion) {
    console.log(`\n✅ Updated: ${result.name} v${result.previousVersion} → v${result.newVersion}`);
  } else if (result.previousVersion) {
    console.log(`\n✅ Reinstalled: ${result.name} v${result.version}`);
  } else {
    console.log(`\n✅ Successfully installed: ${result.name} v${result.version}`);
  }

  if (result.pinnedRef) {
    const digestInfo = result.sourceDigest ? ` (resolved: ${result.sourceDigest})` : '';
    console.log(`   Pinned: ${result.pinnedRef}${digestInfo}`);
  } else if (result.sourceDigest) {
    const typeLabel = result.digestType === 'content-hash' ? ' (content)' : '';
    console.log(`   Digest: ${result.sourceDigest}${typeLabel}`);
  }
  console.log(`   Location: ${result.location}`);
}

/**
 * Run the import command
 */
async function runImportCommand(
  source: string | undefined,
  options: ImportCommandOptions
): Promise<void> {
  try {
    if (options.list) {
      listImports(options.verbose);
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

    if (options.update) {
      if (!source) {
        console.error('❌ Please specify an import to update.');
        console.log('Usage: codemachine import --update <name>');
        return;
      }
      await updateImport(source, options.verbose);
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
      console.log('\nVersion strategies:');
      console.log('  --pin <ref>    Pin to specific commit/tag/branch (e.g., --pin v1.0.0)');
      console.log('  --keep         Keep current version, no changes');
      console.log('  --update       Force update to latest (default)');
      console.log('\nOther options:');
      console.log('  -l, --list            List installed imports');
      console.log('  -r, --remove <name>   Remove an import');
      console.log('  -u, --update <name>   Update an installed import');
      console.log('  -v, --verbose         Verbose output');
      console.log('      --force           Force rebind to different source');
      return;
    }

    await installImport(source, options);
  } catch (error) {
    console.error(
      '\n❌ Error:',
      error instanceof Error ? error.message : String(error)
    );
    process.exitCode = 1;
  }
}

/**
 * Register the import command with Commander
 */
export function registerImportCommand(program: Command): void {
  program
    .command('import [source]')
    .description('Import external workflow packages')
    .option('-l, --list', 'List installed imports')
    .option('-r, --remove', 'Remove an import')
    .option('-u, --update', 'Update an installed import')
    .option('-v, --verbose', 'Verbose output')
    .option('--pin <ref>', 'Pin to a specific commit/tag/branch')
    .option('--keep', 'Keep current version, no modifications')
    .option('--force', 'Force rebind to a different source')
    .action(async (source: string | undefined, options: ImportCommandOptions) => {
      await runImportCommand(source, options);
    });
}
