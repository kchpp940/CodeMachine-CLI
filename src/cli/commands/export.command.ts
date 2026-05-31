/**
 * Export command for CodeMachine
 *
 * Usage:
 *   codemachine export [target-path]    Export imports bundle
 *
 * Thin CLI layer — only parameter parsing and output.
 * All logic delegates to the imports installer service.
 */

import type { Command } from 'commander';
import { exportImportsBundle, openImportsDirectory } from '../../shared/imports/index.js';

async function runExportCommand(targetPath: string | undefined): Promise<void> {
  if (targetPath) {
    const result = await exportImportsBundle(targetPath);
    if (result.success) {
      console.log(`✅ Exported ${result.packageCount} package(s)`);
      console.log(`   Location: ${result.bundlePath}`);
    } else {
      console.error(`❌ Export failed: ${result.error}`);
      process.exitCode = 1;
    }
  } else {
    const result = openImportsDirectory();
    if (result.success) {
      console.log(`✅ Opened imports directory (${result.packageCount} package(s))`);
    } else {
      console.error(`❌ Failed to open: ${result.error}`);
      process.exitCode = 1;
    }
  }
}

export function registerExportCommand(program: Command): void {
  program
    .command('export')
    .description('Export installed imports or open the imports directory')
    .argument('[target-path]', 'Optional target path for the export bundle')
    .action(async (targetPath: string | undefined) => {
      await runExportCommand(targetPath);
    });
}
