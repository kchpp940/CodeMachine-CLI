import type { StepOverrides, WorkflowStep } from '../types.js';
import type { MCPConfig } from '../../../infra/mcp/types.js';
import { mainAgents } from '../config.js';
import { resolvePromptPath, formatCheckedPaths } from '../../../shared/imports/index.js';
import { getDevRoot } from '../../../shared/runtime/dev.js';

export function resolveStep(id: string, overrides: StepOverrides = {}): WorkflowStep {
  const agent = mainAgents.find((entry) => entry?.id === id);
  if (!agent) {
    throw new Error(`Unknown main agent: ${id}`);
  }

  const agentName = overrides.agentName ?? agent.name;
  const promptPath = overrides.promptPath ?? agent.promptPath;
  const model = overrides.model ?? agent.model;

  const promptPathMissing = Array.isArray(promptPath)
    ? promptPath.length === 0 || promptPath.some(p => typeof p !== 'string' || p.trim() === '')
    : typeof promptPath !== 'string' || promptPath.trim() === '';

  if (!agentName || promptPathMissing) {
    throw new Error(`Agent ${id} is missing required fields (name or promptPath)`);
  }

  const safePromptPath = promptPath as string | string[];
  const localRoot = getDevRoot() || '';

  const rawPromptPaths = Array.isArray(safePromptPath) ? safePromptPath : [safePromptPath];
  const resolvedPromptPaths: string[] = [];
  for (const p of rawPromptPaths) {
    const resolveResult = resolvePromptPath(p, localRoot);
    if (!resolveResult.path) {
      const checkedPaths = formatCheckedPaths(resolveResult.checkedPaths);
      throw new Error(
        `Agent "${id}" has invalid promptPath: "${p}"${checkedPaths}\n` +
        `Please ensure the prompt file exists in your local prompts/templates/ directory, ` +
        `or in an imported package.`
      );
    }
    resolvedPromptPaths.push(resolveResult.path);
  }

  const finalPromptPath = Array.isArray(safePromptPath) ? resolvedPromptPaths : resolvedPromptPaths[0];

  return {
    type: 'module',
    agentId: agent.id,
    agentName,
    promptPath: finalPromptPath,
    model,
    modelReasoningEffort: overrides.modelReasoningEffort ?? agent.modelReasoningEffort,
    engine: overrides.engine ?? agent.engine, // Override from step or use agent config
    executeOnce: overrides.executeOnce,
    interactive: overrides.interactive,
    tracks: overrides.tracks ?? agent.tracks as string[] | undefined,
    conditions: overrides.conditions ?? agent.conditions as string[] | undefined,
    conditionsAny: overrides.conditionsAny ?? agent.conditionsAny as string[] | undefined,
    mcp: overrides.mcp ?? agent.mcp as MCPConfig | undefined,
  };
}
