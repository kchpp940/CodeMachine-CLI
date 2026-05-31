import { runCursor } from './runner.js';
import { createRunPrompt, createRunAgent, type ExecutorRunOptions } from '../../_shared/index.js';

export type RunAgentOptions = ExecutorRunOptions;

export async function runCursorPrompt(options: {
  agentId: string;
  prompt: string;
  cwd: string;
  model?: string;
}): Promise<void> {
  await createRunPrompt(runCursor, options, 'cursor');
}

export async function runAgent(
  agentId: string,
  prompt: string,
  cwd: string,
  options: RunAgentOptions = {},
): Promise<string> {
  return createRunAgent(runCursor, agentId, prompt, cwd, options, 'cursor');
}
