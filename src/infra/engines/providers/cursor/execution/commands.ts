import { metadata } from '../metadata.js';
import type { EngineOverrideContext } from '../../../core/types.js';

export interface CursorCommandOptions {
  workingDir: string;
  resumeSessionId?: string;
  model?: string;
  cursorConfigDir?: string;
  override?: EngineOverrideContext;
}

export interface CursorCommand {
  command: string;
  args: string[];
}

const MODEL_MAP: Record<string, string> = {
  'gpt-5-codex': 'gpt-5-codex',
  'gpt-4': 'gpt-5',
  'gpt-3.5-turbo': 'cheetah',
  'sonnet': 'sonnet-4.5',
  'claude-sonnet-4.5': 'sonnet-4.5',
  'opus': 'opus-4.1',
  'grok': 'grok',
};

function mapModel(model?: string): string | undefined {
  if (!model) {
    return undefined;
  }

  if (model in MODEL_MAP) {
    return MODEL_MAP[model];
  }

  const validModels = ['auto', 'cheetah', 'sonnet-4.5', 'sonnet-4.5-thinking', 'gpt-5', 'gpt-5-codex', 'opus-4.1', 'grok'];
  if (validModels.includes(model)) {
    return model;
  }

  return undefined;
}

export function buildCursorExecCommand(options: CursorCommandOptions): CursorCommand {
  const { resumeSessionId, model, cursorConfigDir, override } = options;

  if (override && override.engineId !== metadata.id) {
    throw new Error(
      `Engine override mismatch: buildCursorExecCommand called for engine '${metadata.id}' ` +
      `but override specifies engine '${override.engineId}'. ` +
      `This is an internal error - the wrong engine command builder was called.`
    );
  }

  const args: string[] = [
    '-p',
    '--force',
    '--output-format',
    'stream-json',
  ];

  if (resumeSessionId?.trim()) {
    args.push(`--resume=${resumeSessionId.trim()}`);
  }

  const finalModel = override?.model ?? model;
  const mappedModel = mapModel(finalModel);
  if (mappedModel) {
    args.push('--model', mappedModel);
  }

  if (cursorConfigDir) {
    args.push(cursorConfigDir);
  }

  return {
    command: metadata.cliBinary,
    args,
  };
}
