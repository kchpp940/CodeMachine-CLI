import {
  type SharedCommandOptions,
  type ProviderCommand,
  addModelArg,
  addResumeArg,
  getProviderCapabilities,
  getModelMapping,
} from '../../_shared/index.js';

export type ClaudeCommandOptions = SharedCommandOptions;
export type ClaudeCommand = ProviderCommand;

const caps = getProviderCapabilities('claude');
const modelMapping = getModelMapping('claude')!;

export function buildClaudeExecCommand(options: ClaudeCommandOptions): ClaudeCommand {
  const { resumeSessionId, model } = options;

  const args: string[] = [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--permission-mode',
    'bypassPermissions',
  ];

  addResumeArg(args, resumeSessionId, caps.resumeFlag, caps.useResumeEquals);
  addModelArg(args, model, modelMapping, caps.modelFlag);

  return {
    command: 'claude',
    args,
  };
}
