import { runMistral } from './runner.js';
import { createRunPrompt, createRunAgent, type ExecutorRunOptions } from '../../_shared/index.js';

export type RunAgentOptions = ExecutorRunOptions;

export async function runMistralPrompt(options: {
  agentId: string;
  prompt: string;
  cwd: string;
  model?: string;
}): Promise<void> {
  await createRunPrompt(runMistral, options, 'mistral');
}

export async function runAgent(
  agentId: string,
  prompt: string,
  cwd: string,
  options: RunAgentOptions = {},
): Promise<string> {
  return createRunAgent(runMistral, agentId, prompt, cwd, options, 'mistral');
}
