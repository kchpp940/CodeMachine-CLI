import { runOpenCode } from './runner.js';
import { createRunPrompt, createRunAgent, type ExecutorRunOptions } from '../../_shared/index.js';

export type RunAgentOptions = ExecutorRunOptions;

export async function runOpenCodePrompt(options: {
  agentId: string;
  prompt: string;
  cwd: string;
  model?: string;
  agent?: string;
}): Promise<void> {
  await createRunPrompt(runOpenCode, options, 'opencode');
}

export async function runAgent(
  agentId: string,
  prompt: string,
  cwd: string,
  options: RunAgentOptions = {},
): Promise<string> {
  return createRunAgent(runOpenCode, agentId, prompt, cwd, options, 'opencode');
}
