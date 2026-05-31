import {
  type SharedCommandOptions,
  type ProviderCommand,
  addResumeArg,
  getProviderCapabilities,
} from '../../_shared/index.js';

export type MistralCommandOptions = SharedCommandOptions & { prompt: string };
export type MistralCommand = ProviderCommand;

const caps = getProviderCapabilities('mistral');

export function buildMistralExecCommand(options: MistralCommandOptions): MistralCommand {
  const { resumeSessionId, resumePrompt, prompt } = options;

  const args: string[] = [
    '-p',
    resumeSessionId ? resumePrompt! : prompt,
    '--auto-approve',
    '--output',
    'streaming',
  ];

  addResumeArg(args, resumeSessionId, caps.resumeFlag, caps.useResumeEquals);

  return {
    command: 'vibe',
    args,
  };
}
