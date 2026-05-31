import {
  type SharedCommandOptions,
  type ProviderCommand,
  normalizeModel,
  normalizeResumeSessionId,
  getProviderCapabilities,
} from '../../_shared/index.js';

export type OpenCodeCommandOptions = SharedCommandOptions & {
  agent?: string;
};

export type OpenCodeCommand = ProviderCommand;

const caps = getProviderCapabilities('opencode');

export function buildOpenCodeRunCommand(options: OpenCodeCommandOptions): OpenCodeCommand {
  const { resumeSessionId, model, agent } = options;

  const args: string[] = ['run', '--format', 'json'];

  const normalizedResumeId = normalizeResumeSessionId(resumeSessionId);
  if (normalizedResumeId) {
    args.push(caps.resumeFlag, normalizedResumeId);
  }

  const agentName = agent?.trim() || 'build';
  args.push('--agent', agentName);

  const normalizedModel = normalizeModel(model);
  if (normalizedModel) {
    args.push(caps.modelFlag, normalizedModel);
  }

  return {
    command: 'opencode',
    args,
  };
}
