/**
 * Import command for CodeMachine
 *
 * Usage:
 *   codemachine import <source>           Install/update an import
 *   codemachine import --list             List installed imports
 *   codemachine import --remove <name>    Remove an import
 *
 * This command is a thin CLI layer — parameter parsing and output only.
 * All install / uninstall logic lives in `shared/imports/installer.ts`.
 */

import type { Command } from 'commander';
import {
  installPackage,
  uninstallPackage,
  getAllInstalledImports,
} from '../../shared/imports/index.js';

interface ImportCommandOptions {
  list?: boolean;
  remove?: boolean;
  verbose?: boolean;
}

async function runInstall(source: string, verbose: boolean): Promise<void> {
  console.log(`\nImporting: ${source}`);

  const result = await installPackage(source);

  if (result.success) {
    console.log(`\n✅ Successfully installed: ${result.name} v${result.version}`);
    console.log(`   Location: ${result.location}`);
  } else {
    console.error(`\n❌ Installation failed: ${result.error}`);
    if (result.errorDetails) {
      console.error(`   ${result.errorDetails}`);
    }
    throw new Error(result.error);
  }
}

async function runRemove(name: string): Promise<void> {
  const result = uninstallPackage(name);

  if (result.success) {
    console.log(`✅ Successfully removed: ${result.name}`);
  } else {
    console.error(`\n❌ ${result.error}: ${name}`);
    console.log('\nUse "codemachine import --list" to see installed imports.');
  }
}

function runList(): void {
  const imports = getAllInstalledImports();

  if (imports.length === 0) {
    console.log('\nNo imports installed.');
    console.log('\nTo install an import, use:');
    console.log('  codemachine import <package-name>');
    console.log('  codemachine import <owner>/<repo>');
    console.log('  codemachine import <https://github.com/...>');
    console.log('  codemachine import </path/to/folder>  (local with .codemachine.json)');
    return;
  }

  console.log('\nInstalled imports:\n');

  for (const imp of imports) {
    console.log(`  ${imp.name} v${imp.version}`);
    console.log(`    Source: ${imp.source}`);
    console.log(`    Path: ${imp.path}`);
    console.log(`    Installed: ${new Date(imp.installedAt).toLocaleDateString()}`);
    console.log('');
  }

  console.log(`Total: ${imports.length} import(s)`);
}

async function runImportCommand(
  source: string | undefined,
  options: ImportCommandOptions,
): Promise<void> {
  try {
    if (options.list) {
      runList();
      return;
    }

    if (options.remove) {
      if (!source) {
        console.error('❌ Please specify an import to remove.');
        console.log('Usage: codemachine import --remove <name>');
        return;
      }
      await runRemove(source);
      return;
    }

    if (!source) {
      console.error('❌ Please specify a source to import.');
      console.log('\nUsage:');
      console.log('  codemachine import <package-name>');
      console.log('  codemachine import <owner>/<repo>');
      console.log('  codemachine import <https://github.com/...>');
      console.log('  codemachine import </path/to/folder>   (local path with .codemachine.json)');
      console.log('  codemachine import <./relative/path>   (local path with .codemachine.json)');
      console.log('\nOther options:');
      console.log('  codemachine import --list            List installed imports');
      console.log('  codemachine import --remove <name>   Remove an import');
      return;
    }

    await runInstall(source, options.verbose ?? false);
  } catch (error) {
    console.error(
      '\n❌ Error:',
      error instanceof Error ? error.message : String(error),
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
