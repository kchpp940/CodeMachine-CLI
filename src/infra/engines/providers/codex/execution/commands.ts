import { metadata } from '../metadata.js';
import type { EngineOverrideContext } from '../../../core/types.js';

export interface CodexCommandOptions {
  workingDir: string;
  resumeSessionId?: string;
  resumePrompt?: string;
  model?: string;
  modelReasoningEffort?: 'low' | 'medium' | 'high';
  override?: EngineOverrideContext;
}

export interface CodexCommand {
  command: string;
  args: string[];
}

export function buildCodexCommand(options: CodexCommandOptions): CodexCommand {
  const { workingDir, resumeSessionId, resumePrompt, model, modelReasoningEffort, override } = options;

  if (override && override.engineId !== metadata.id) {
    throw new Error(
      `Engine override mismatch: buildCodexCommand called for engine '${metadata.id}' ` +
      `but override specifies engine '${override.engineId}'. ` +
      `This is an internal error - the wrong engine command builder was called.`
    );
  }

  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--sandbox',
    'danger-full-access',
    '--dangerously-bypass-approvals-and-sandbox',
    '-C',
    workingDir,
  ];

  const finalModel = override?.model ?? model;
  if (finalModel && !resumeSessionId) {
    args.push('--model', finalModel);
  }

  if (modelReasoningEffort) {
    args.push('--config', `model_reasoning_effort="${modelReasoningEffort}"`);
  }

  if (resumeSessionId) {
    args.push('resume', resumeSessionId, resumePrompt!);
  } else {
    args.push('-');
  }

  return { command: metadata.cliBinary, args };
}
