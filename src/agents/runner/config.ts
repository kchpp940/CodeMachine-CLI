import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { collectAgentDefinitions, resolveProjectRoot } from '../../shared/agents/index.js';
import type { AgentDefinition } from '../../shared/agents/config/types.js';
import { resolvePromptPath, formatCheckedPaths } from '../../shared/imports/index.js';
import { getDevRoot } from '../../shared/runtime/dev.js';

const localRoot = getDevRoot() || '';

export type AgentConfig = AgentDefinition & {
  name: string;
  description?: string;
  promptPath?: string | string[];
};

/**
 * Slugify a string to create a valid filename
 */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

/**
 * Generate the default prompt path based on agent ID
 */
function getDefaultPromptPath(agentId: string): string {
  const slugBase = slugify(agentId) || 'agent';
  return path.join('.codemachine', 'agents', `${slugBase}.md`);
}

/**
 * Loads the agent configuration by ID from all available agent files
 */
export async function loadAgentConfig(agentId: string, projectRoot?: string): Promise<AgentConfig> {
  const lookupBase = projectRoot ?? process.env.CODEMACHINE_CWD ?? process.cwd();
  const resolvedRoot = resolveProjectRoot(lookupBase);

  // Collect all agent definitions from all config files
  const agents = await collectAgentDefinitions(resolvedRoot);

  const config = agents.find((a) => a.id === agentId) as AgentConfig | undefined;
  if (!config) {
    throw new Error(`Unknown agent id: ${agentId}. Available agents: ${agents.map(a => a.id).join(', ')}`);
  }

  return config;
}

/**
 * Loads the agent prompt template
 */
export async function loadAgentTemplate(agentId: string, projectRoot?: string): Promise<string> {
  const config = await loadAgentConfig(agentId, projectRoot);

  // Use config.promptPath if provided, otherwise generate default path from agent ID
  const configuredPath = config.promptPath ?? getDefaultPromptPath(agentId);
  const promptSources = Array.isArray(configuredPath) ? configuredPath : [configuredPath];

  if (promptSources.length === 0) {
    throw new Error(`Agent ${agentId} has an empty promptPath configuration`);
  }
  if (promptSources.some(p => typeof p !== 'string' || p.trim() === '')) {
    throw new Error(`Agent ${agentId} has an invalid promptPath configuration`);
  }

  // If path is absolute, use it directly; otherwise check local first, then imports
  const resolvedPromptPaths: string[] = [];
  for (const p of promptSources) {
    if (path.isAbsolute(p)) {
      resolvedPromptPaths.push(p);
    } else {
      const resolveResult = resolvePromptPath(p, localRoot);
      if (resolveResult.path) {
        resolvedPromptPaths.push(resolveResult.path);
      } else {
        const checkedPaths = formatCheckedPaths(resolveResult.checkedPaths);
        throw new Error(
          `Relative promptPath "${p}" could not be resolved for agent "${agentId}".${checkedPaths}\n` +
          `Please ensure the prompt file exists in your local prompts/templates/ directory, ` +
          `or in an imported package.`
        );
      }
    }
  }

  const contentParts = await Promise.all(
    resolvedPromptPaths.map(async (resolvedPath, idx) => {
      try {
        return await fs.readFile(resolvedPath, 'utf-8');
      } catch (fileError) {
        const originalPath = promptSources[idx];
        if (path.isAbsolute(originalPath)) {
          throw new Error(
            `Resolved prompt file does not exist: "${resolvedPath}"\n` +
            `This path was already resolved to an absolute path by the step resolver. ` +
            `The file may have been moved or deleted after the workflow started.`
          );
        }
        throw new Error(
          `Failed to read agent prompt "${originalPath}" resolved to "${resolvedPath}": ` +
          `${fileError instanceof Error ? fileError.message : String(fileError)}`
        );
      }
    }),
  );
  return contentParts.join('\n\n');
}
