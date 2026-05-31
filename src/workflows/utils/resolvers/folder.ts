import { readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { StepOverrides, WorkflowStep } from '../types.js';
import { mainAgents } from '../config.js';
import { resolvePromptPath, resolvePromptFolder, formatCheckedPaths } from '../../../shared/imports/index.js';
import { getDevRoot } from '../../../shared/runtime/dev.js';

function extractOrderPrefix(filename: string): number | null {
  const match = filename.match(/^(\d+)\s*-/);
  return match ? parseInt(match[1], 10) : null;
}

export function resolveFolder(folderName: string, overrides: StepOverrides = {}): WorkflowStep[] {
  // Look up folder configuration from main.agents.js
  const folderConfig = mainAgents.find((entry) => entry?.type === 'folder' && entry?.id === folderName);

  if (!folderConfig) {
    throw new Error(`Folder configuration not found in main.agents.js: ${folderName}`);
  }

  // Check local first, then imported packages
  const localRoot = getDevRoot() || '';
  const resolveResult = resolvePromptFolder(folderName, localRoot);
  const promptsDir = resolveResult.path;

  if (!promptsDir || !statSync(promptsDir).isDirectory()) {
    const checkedPaths = formatCheckedPaths(resolveResult.checkedPaths);
    throw new Error(`Folder not found: prompts/templates/${folderName}${checkedPaths}`);
  }

  const files = readdirSync(promptsDir);

  // Filter and sort files by their numeric prefix
  const orderedFiles = files
    .map((file) => ({
      file,
      order: extractOrderPrefix(file),
      fullPath: path.join(promptsDir, file),
    }))
    .filter((item) => item.order !== null && statSync(item.fullPath).isFile())
    .sort((a, b) => (a.order! - b.order!));

  if (orderedFiles.length === 0) {
    throw new Error(`No ordered files found in folder: ${promptsDir}`);
  }

  // Create a step for each file using folder config
  return orderedFiles.map((item) => {
    const basename = item.file;
    const ext = path.extname(basename);

    // Remove number prefix and extension to get the agent ID
    const agentId = basename.replace(/^\d+\s*-\s*/, '').replace(ext, '').trim();
    // Use absolute path since promptsDir is already resolved
    const defaultPromptPath = path.join(promptsDir, basename);
    const model = overrides.model ?? folderConfig.model;

    if (!model) {
      throw new Error(`Folder config ${folderName} is missing a model configuration`);
    }

    let finalPromptPath: string | string[] = defaultPromptPath;
    if (overrides.promptPath) {
      const rawOverridePaths = Array.isArray(overrides.promptPath) ? overrides.promptPath : [overrides.promptPath];
      const resolvedOverridePaths: string[] = [];
      for (const p of rawOverridePaths) {
        const resolveResult = resolvePromptPath(p, localRoot);
        if (!resolveResult.path) {
          const checkedPaths = formatCheckedPaths(resolveResult.checkedPaths);
          throw new Error(
            `Folder "${folderName}" has invalid promptPath override: "${p}"${checkedPaths}\n` +
            `Please ensure the prompt file exists in your local prompts/templates/ directory, ` +
            `or in an imported package.`
          );
        }
        resolvedOverridePaths.push(resolveResult.path);
      }
      finalPromptPath = Array.isArray(overrides.promptPath) ? resolvedOverridePaths : resolvedOverridePaths[0];
    }

    return {
      type: 'module',
      agentId,
      agentName: overrides.agentName ?? agentId.replace(/-/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase()),
      promptPath: finalPromptPath,
      model,
      modelReasoningEffort: overrides.modelReasoningEffort ?? folderConfig.modelReasoningEffort,
    };
  });
}
