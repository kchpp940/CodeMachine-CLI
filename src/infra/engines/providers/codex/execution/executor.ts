import { runCodex } from './runner.js';
import { createRunPrompt, createRunAgent, type ExecutorRunOptions } from '../../_shared/index.js';

export type RunAgentOptions = ExecutorRunOptions;

export async function runCodexPrompt(options: {
  agentId: string;
  prompt: string;
  cwd: string;
}): Promise<void> {
  await createRunPrompt(runCodex, options, 'codex');
}

export async function runAgent(
  agentId: string,
  prompt: string,
  cwd: string,
  options: RunAgentOptions = {},
): Promise<string> {
  return createRunAgent(runCodex, agentId, prompt, cwd, options, 'codex');
}
