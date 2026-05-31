import type { ProviderCommandOptions, ProviderCommand } from '../../shared/commandUtils.js';
import { validateAllOptions } from '../../shared/commandUtils.js';

export interface CursorCommandOptions extends ProviderCommandOptions {
  cursorConfigDir?: string;
}

export type CursorCommand = ProviderCommand;

const MODEL_MAP: Record<string, string> = {
  'gpt-5-codex': 'gpt-5-codex',
  'gpt-4': 'gpt-5',
  'gpt-3.5-turbo': 'cheetah',
  'sonnet': 'sonnet-4.5',
  'claude-sonnet-4.5': 'sonnet-4.5',
  'opus': 'opus-4.1',
  'grok': 'grok',
};

const VALID_MODELS = [
  'auto',
  'cheetah',
  'sonnet-4.5',
  'sonnet-4.5-thinking',
  'gpt-5',
  'gpt-5-codex',
  'opus-4.1',
  'grok',
];

const MODEL_CONFIG = {
  modelMap: MODEL_MAP,
  validModels: VALID_MODELS,
  providerName: 'Cursor',
  modelSupport: 'supported' as const,
};

export function buildCursorExecCommand(options: CursorCommandOptions): CursorCommand {
  const validation = validateAllOptions(options, MODEL_CONFIG);
  if (!validation.isValid) {
    throw new Error(validation.error);
  }

  const { mappedModel, isResume } = validation;

  const args: string[] = [
    '-p',
    '--force',
    '--output-format',
    'stream-json',
  ];

  if (isResume) {
    args.push(`--resume=${options.resumeSessionId!.trim()}`);
  }

  if (mappedModel) {
    args.push('--model', mappedModel);
  }

  if (options.cursorConfigDir) {
    args.push(options.cursorConfigDir);
  }

  return {
    command: 'cursor-agent',
    args,
  };
}
