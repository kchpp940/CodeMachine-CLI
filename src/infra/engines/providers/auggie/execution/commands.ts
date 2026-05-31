import {
  type SharedCommandOptions,
  type ProviderCommand,
  addResumeArg,
  getProviderCapabilities,
} from '../../_shared/index.js';

export type AuggieCommandOptions = SharedCommandOptions;
export type AuggieCommand = ProviderCommand;

const caps = getProviderCapabilities('auggie');

export function buildAuggieRunCommand(options: AuggieCommandOptions): AuggieCommand {
  const { resumeSessionId } = options;

  const args: string[] = ['--print', '--quiet', '--output-format', 'json'];

  addResumeArg(args, resumeSessionId, caps.resumeFlag, caps.useResumeEquals);

  return {
    command: 'auggie',
    args,
  };
}
