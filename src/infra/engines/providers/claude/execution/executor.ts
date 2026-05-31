import { runClaude } from './runner.js';
import { createRunPrompt, createRunAgent, type ExecutorRunOptions } from '../../_shared/index.js';

export type RunAgentOptions = ExecutorRunOptions;

export async function runClaudePrompt(options: {
  agentId: string;
  prompt: string;
  cwd: string;
  model?: string;
}): Promise<void> {
  await createRunPrompt(runClaude, options, 'claude');
}

export async function runAgent(
  agentId: string,
  prompt: string,
  cwd: string,
  options: RunAgentOptions = {},
): Promise<string> {
  return createRunAgent(runClaude, agentId, prompt, cwd, options, 'claude');
}
