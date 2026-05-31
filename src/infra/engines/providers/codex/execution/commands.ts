import type { ProviderCommandOptions, ProviderCommand } from '../../shared/commandUtils.js';
import { validateAllOptions } from '../../shared/commandUtils.js';

export type CodexCommandOptions = ProviderCommandOptions;
export type CodexCommand = ProviderCommand;

const MODEL_MAP: Record<string, string> = {
  'gpt-5-codex': 'gpt-5-codex',
  'gpt-4': 'gpt-5-codex',
};

const VALID_MODELS = [
  'gpt-5-codex',
  'gpt-4o-codex',
];

const MODEL_CONFIG = {
  modelMap: MODEL_MAP,
  validModels: VALID_MODELS,
  providerName: 'Codex',
  modelSupport: 'supported' as const,
};

export function buildCodexCommand(options: CodexCommandOptions): CodexCommand {
  const validation = validateAllOptions(options, MODEL_CONFIG);
  if (!validation.isValid) {
    throw new Error(validation.error);
  }

  const { mappedModel, validatedResumePrompt, isResume } = validation;

  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--sandbox',
    'danger-full-access',
    '--dangerously-bypass-approvals-and-sandbox',
    '-C',
    options.workingDir,
  ];

  if (mappedModel) {
    args.push('--model', mappedModel);
  }

  if (options.modelReasoningEffort) {
    args.push('--config', `model_reasoning_effort="${options.modelReasoningEffort}"`);
  }

  if (isResume) {
    args.push('resume', options.resumeSessionId!, validatedResumePrompt!);
  } else {
    args.push('-');
  }

  return { command: 'codex', args };
}
