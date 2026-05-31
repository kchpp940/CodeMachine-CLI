import { runAuggie } from './runner.js';
import { createRunPrompt, type ExecutorRunOptions } from '../../_shared/index.js';

export type RunAgentOptions = ExecutorRunOptions;

export async function runAuggiePrompt(options: {
  agentId: string;
  prompt: string;
  cwd: string;
  model?: string;
}): Promise<void> {
  await createRunPrompt(runAuggie, options, 'auggie');
}
