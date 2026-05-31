import {
  type SharedCommandOptions,
  type ProviderCommand,
  addResumeArg,
  addReasoningEffortArg,
  normalizeModel,
  normalizeResumeSessionId,
  getProviderCapabilities,
} from '../../_shared/index.js';

export type CodexCommandOptions = SharedCommandOptions;
export type CodexCommand = ProviderCommand;

const caps = getProviderCapabilities('codex');

export function buildCodexCommand(options: CodexCommandOptions): CodexCommand {
  const { workingDir, resumeSessionId, resumePrompt, model, modelReasoningEffort } = options;

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

  const normalizedModel = normalizeModel(model);
  if (normalizedModel && !resumeSessionId) {
    args.push(caps.modelFlag, normalizedModel);
  }

  addReasoningEffortArg(args, modelReasoningEffort);

  const normalizedResumeId = normalizeResumeSessionId(resumeSessionId);
  if (normalizedResumeId) {
    args.push(caps.resumeFlag, normalizedResumeId, resumePrompt!);
  } else {
    args.push('-');
  }

  return { command: 'codex', args };
}
