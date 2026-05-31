import { metadata } from '../metadata.js';
import type { EngineOverrideContext } from '../../../core/types.js';

export interface ClaudeCommandOptions {
  workingDir: string;
  resumeSessionId?: string;
  model?: string;
  override?: EngineOverrideContext;
}

export interface ClaudeCommand {
  command: string;
  args: string[];
}

const MODEL_MAP: Record<string, string> = {
  'gpt-5-codex': 'sonnet',
  'gpt-4': 'sonnet',
  'gpt-3.5-turbo': 'haiku',
};

function mapModel(model?: string): string | undefined {
  if (!model) {
    return undefined;
  }

  if (model in MODEL_MAP) {
    return MODEL_MAP[model];
  }

  if (model.startsWith('claude-') || model === 'sonnet' || model === 'opus' || model === 'haiku') {
    return model;
  }

  return undefined;
}

export function buildClaudeExecCommand(options: ClaudeCommandOptions): ClaudeCommand {
  const { resumeSessionId, model, override } = options;

  if (override && override.engineId !== metadata.id) {
    throw new Error(
      `Engine override mismatch: buildClaudeExecCommand called for engine '${metadata.id}' ` +
      `but override specifies engine '${override.engineId}'. ` +
      `This is an internal error - the wrong engine command builder was called.`
    );
  }

  const args: string[] = [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--permission-mode',
    'bypassPermissions',
  ];

  if (resumeSessionId?.trim()) {
    args.push('--resume', resumeSessionId.trim());
  }

  const finalModel = override?.model ?? model;
  const mappedModel = mapModel(finalModel);
  if (mappedModel) {
    args.push('--model', mappedModel);
  }

  return {
    command: metadata.cliBinary,
    args,
  };
}
