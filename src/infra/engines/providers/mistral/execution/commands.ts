import type { ProviderCommandOptions, ProviderCommand } from '../../shared/commandUtils.js';
import { validateAllOptions } from '../../shared/commandUtils.js';

export interface MistralCommandOptions extends ProviderCommandOptions {
  prompt: string;
}

export type MistralCommand = ProviderCommand;

const MODEL_CONFIG = {
  modelMap: {} as Record<string, string>,
  validModels: [] as string[],
  providerName: 'Mistral',
  modelSupport: 'ignored' as const,
};

export function buildMistralExecCommand(options: MistralCommandOptions): MistralCommand {
  const validation = validateAllOptions(options, MODEL_CONFIG);
  if (!validation.isValid) {
    throw new Error(validation.error);
  }

  const { validatedResumePrompt, isResume } = validation;

  const effectivePrompt = isResume ? validatedResumePrompt! : options.prompt;

  const args: string[] = [
    '-p',
    effectivePrompt,
    '--auto-approve',
    '--output',
    'streaming',
  ];

  if (isResume) {
    args.push('--resume', options.resumeSessionId!.trim());
  }

  return {
    command: 'vibe',
    args,
  };
}
