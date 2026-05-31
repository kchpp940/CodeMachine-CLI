import type { ProviderCommandOptions, ProviderCommand } from '../../shared/commandUtils.js';
import { validateAllOptions } from '../../shared/commandUtils.js';

export type ClaudeCommandOptions = ProviderCommandOptions;
export type ClaudeCommand = ProviderCommand;

const MODEL_MAP: Record<string, string> = {
  'gpt-5-codex': 'sonnet',
  'gpt-4': 'sonnet',
  'gpt-3.5-turbo': 'haiku',
};

const VALID_MODELS = [
  'sonnet',
  'opus',
  'haiku',
  'claude-sonnet-4.5',
  'claude-opus-4.1',
  'claude-haiku-4.1',
];

const MODEL_CONFIG = {
  modelMap: MODEL_MAP,
  validModels: VALID_MODELS,
  providerName: 'Claude',
  modelSupport: 'supported' as const,
};

export function buildClaudeExecCommand(options: ClaudeCommandOptions): ClaudeCommand {
  const validation = validateAllOptions(options, MODEL_CONFIG);
  if (!validation.isValid) {
    throw new Error(validation.error);
  }

  const { mappedModel, isResume } = validation;

  const args: string[] = [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--permission-mode',
    'bypassPermissions',
  ];

  if (isResume) {
    args.push('--resume', options.resumeSessionId!.trim());
  }

  if (mappedModel) {
    args.push('--model', mappedModel);
  }

  return {
    command: 'claude',
    args,
  };
}
