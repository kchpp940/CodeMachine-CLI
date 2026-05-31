import {
  type SharedCommandOptions,
  type ProviderCommand,
  addModelArg,
  addResumeArg,
  getProviderCapabilities,
  getModelMapping,
} from '../../_shared/index.js';

export type CcrCommandOptions = SharedCommandOptions;
export type CcrCommand = ProviderCommand;

const caps = getProviderCapabilities('ccr');
const modelMapping = getModelMapping('ccr')!;

export function buildCcrExecCommand(options: CcrCommandOptions): CcrCommand {
  const { resumeSessionId, model } = options;

  const args: string[] = [
    'code',
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
    command: 'ccr',
    args,
  };
}
