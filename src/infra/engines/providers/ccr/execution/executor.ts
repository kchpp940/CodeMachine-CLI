import { runCcr } from './runner.js';
import { createRunPrompt, createRunAgent, type ExecutorRunOptions } from '../../_shared/index.js';

export type RunAgentOptions = ExecutorRunOptions;

export async function runCcrPrompt(options: {
  agentId: string;
  prompt: string;
  cwd: string;
  model?: string;
}): Promise<void> {
  await createRunPrompt(runCcr, options, 'ccr');
}

export async function runAgent(
  agentId: string,
  prompt: string,
  cwd: string,
  options: RunAgentOptions = {},
): Promise<string> {
  return createRunAgent(runCcr, agentId, prompt, cwd, options, 'ccr');
}
