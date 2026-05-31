import type { ProviderCommandOptions, ProviderCommand } from '../../shared/commandUtils.js';
import { validateAllOptions } from '../../shared/commandUtils.js';

export interface OpenCodeCommandOptions extends ProviderCommandOptions {
  agent?: string;
}

export type OpenCodeCommand = ProviderCommand;

const MODEL_CONFIG = {
  modelMap: {} as Record<string, string>,
  validModels: [] as string[],
  providerName: 'OpenCode',
  modelSupport: 'supported' as const,
};

export function buildOpenCodeRunCommand(options: OpenCodeCommandOptions): OpenCodeCommand {
  const validation = validateAllOptions(options, MODEL_CONFIG);
  if (!validation.isValid) {
    throw new Error(validation.error);
  }

  const { isResume } = validation;

  const args: string[] = ['run', '--format', 'json'];

  if (isResume) {
    args.push('--session', options.resumeSessionId!.trim());
  }

  const agentName = options.agent?.trim() || 'build';
  if (agentName) {
    args.push('--agent', agentName);
  }

  if (options.model?.trim()) {
    args.push('--model', options.model.trim());
  }

  return {
    command: 'opencode',
    args,
  };
}
