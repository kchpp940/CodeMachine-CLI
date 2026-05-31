import * as readline from 'node:readline';
import type { DryPreviewResult } from './dry-preview.js';
import { dryPreview, formatDryPreviewResult } from './dry-preview.js';

export interface DryPreviewCLIOptions {
  cwd?: string;
  /** @deprecated Use `confirm` instead */
  skipConfirm?: boolean;
  /** @deprecated Use explicit `confirm: 'yes'` for non-interactive approval */
  nonInteractive?: boolean;
  quiet?: boolean;
  /**
   * Confirmation mode:
   * - 'interactive': prompt user for confirmation (default in TTY)
   * - 'yes': auto-confirm (requires explicit flag)
   * - 'no': auto-reject (default in non-TTY)
   */
  confirm?: 'interactive' | 'yes' | 'no';
}

export class DryPreviewAbortedError extends Error {
  constructor(message = 'Workflow execution aborted by user') {
    super(message);
    this.name = 'DryPreviewAbortedError';
  }
}

export class DryPreviewNotConfirmedError extends DryPreviewAbortedError {
  constructor(message = 'Dry preview not confirmed. Pass --yes to auto-confirm in non-interactive environments.') {
    super(message);
    this.name = 'DryPreviewNotConfirmedError';
  }
}

export interface DryPreviewConfirmedResult extends DryPreviewResult {
  confirmed: true;
  confirmedBy: 'user' | 'flag';
}

export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function resolveConfirmMode(options: DryPreviewCLIOptions): 'interactive' | 'yes' | 'no' {
  if (options.confirm === 'yes' || options.skipConfirm === true) return 'yes';
  if (options.confirm === 'no') return 'no';
  if (options.nonInteractive === true) return 'no';
  if (options.confirm === 'interactive') return 'interactive';
  return isInteractive() ? 'interactive' : 'no';
}

export async function runDryPreviewCLI(options: DryPreviewCLIOptions = {}): Promise<DryPreviewConfirmedResult> {
  const cwd = options.cwd || process.cwd();
  const result = await dryPreview({ cwd });

  if (!options.quiet) {
    console.log(formatDryPreviewResult(result));
    console.log();
  }

  if (!result.valid) {
    const errors = result.issues.filter(i => i.severity === 'error');
    throw new DryPreviewAbortedError(
      `Workflow validation failed with ${errors.length} error(s). Fix the issues above and try again.`
    );
  }

  const confirmMode = resolveConfirmMode(options);

  if (confirmMode === 'yes') {
    return { ...result, confirmed: true, confirmedBy: 'flag' };
  }

  if (confirmMode === 'no') {
    throw new DryPreviewNotConfirmedError();
  }

  const confirmed = await promptConfirmation();
  if (!confirmed) {
    throw new DryPreviewAbortedError('User cancelled workflow execution');
  }

  return { ...result, confirmed: true, confirmedBy: 'user' };
}

function promptConfirmation(): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question('Start workflow execution? [Y/n] ', (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      const confirmed = trimmed === '' || trimmed === 'y' || trimmed === 'yes';
      resolve(confirmed);
    });
  });
}
