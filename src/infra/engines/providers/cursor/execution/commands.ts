import {
  type SharedCommandOptions,
  type ProviderCommand,
  addModelArg,
  addResumeArg,
  getProviderCapabilities,
  getModelMapping,
} from '../../_shared/index.js';

export type CursorCommandOptions = SharedCommandOptions & {
  cursorConfigDir?: string;
};
export type CursorCommand = ProviderCommand;

const caps = getProviderCapabilities('cursor');
const modelMapping = getModelMapping('cursor')!;

export function buildCursorExecCommand(options: CursorCommandOptions): CursorCommand {
  const { resumeSessionId, model, cursorConfigDir } = options;

  const args: string[] = [
    '-p',
    '--force',
    '--output-format',
    'stream-json',
  ];

  addResumeArg(args, resumeSessionId, caps.resumeFlag, caps.useResumeEquals);
  addModelArg(args, model, modelMapping, caps.modelFlag);

  if (cursorConfigDir) {
    args.push(cursorConfigDir);
  }

  return {
    command: 'cursor-agent',
    args,
  };
}
