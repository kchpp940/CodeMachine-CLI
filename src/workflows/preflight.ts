/**
 * Workflow Pre-flight Checks
 *
 * Consolidates all checks that must pass before a workflow can start.
 * Single source of truth for workflow startup validation.
 */

import * as path from 'node:path';
import { existsSync } from 'node:fs';
import type { WorkflowTemplate, WorkflowStep } from './templates/types.js';
import { isModuleStep } from './templates/types.js';
import { loadTemplateWithPath } from './templates/loader.js';
import {
  getTemplatePathFromTracking,
  getSelectedTrack,
  hasSelectedConditions,
  getProjectName,
  validateWorkflowTemplateExists,
} from '../shared/workflows/index.js';
import { validateSpecification } from '../runtime/services/index.js';
import { ensureWorkspaceStructure } from '../runtime/services/workspace/index.js';
import type { AgentDefinition } from '../shared/agents/config/types.js';
import { registerImportedAgents, clearImportedAgents } from './utils/config.js';
import {
  getAllInstalledImports,
  resolvePromptPath,
  formatCheckedPaths,
} from '../shared/imports/index.js';
import { getDevRoot } from '../shared/runtime/dev.js';

export { ValidationError } from '../runtime/services/index.js';

/**
 * Ensure imported agents are registered before loading templates
 * This must be called before any loadTemplateWithPath() call to ensure
 * resolveStep() can find agents from imported packages
 */
function ensureImportedAgentsRegistered(): void {
  clearImportedAgents();
  const importedPackages = getAllInstalledImports();
  for (const imp of importedPackages) {
    registerImportedAgents(imp.resolvedPaths.config);
  }
}

/**
 * Validate all prompt paths in a workflow step
 * @param step - Workflow step to validate
 * @param localRoot - Local root directory for path resolution
 * @returns Array of validation errors (empty if all paths are valid)
 */
function validateStepPromptPaths(step: WorkflowStep, localRoot: string): string[] {
  const errors: string[] = [];

  if (!isModuleStep(step)) {
    return errors;
  }

  const promptPaths = Array.isArray(step.promptPath) ? step.promptPath : [step.promptPath];

  for (const promptPath of promptPaths) {
    if (path.isAbsolute(promptPath)) {
      if (!existsSync(promptPath)) {
        errors.push(
          `Resolved prompt file does not exist: "${promptPath}"\n` +
          `    This path was already resolved to an absolute path by the step resolver. ` +
          `The file may have been moved or deleted after the workflow started.`
        );
      }
      continue;
    }

    const resolveResult = resolvePromptPath(promptPath, localRoot);
    if (!resolveResult.path) {
      const checkedPaths = formatCheckedPaths(resolveResult.checkedPaths);
      errors.push(
        `Relative promptPath "${promptPath}" could not be resolved.${checkedPaths}`
      );
    }
  }

  return errors;
}

/**
 * Validate all prompt paths in a workflow template before execution
 * Throws an error with detailed information if any prompt paths are missing
 * @param template - Loaded workflow template
 * @param localRoot - Local root directory for path resolution
 * @throws Error with detailed information if any prompt paths are missing
 */
export function validateAllPromptPaths(template: WorkflowTemplate, localRoot: string): void {
  const allErrors: string[] = [];

  for (let i = 0; i < template.steps.length; i++) {
    const step = template.steps[i];
    const stepErrors = validateStepPromptPaths(step, localRoot);
    if (stepErrors.length > 0) {
      allErrors.push(...stepErrors.map(err => `  Step ${i + 1} (${step.type}): ${err}`));
    }
  }

  if (allErrors.length > 0) {
    throw new Error(
      `Workflow template "${template.name}" has ${allErrors.length} missing prompt file(s):\n` +
      allErrors.join('\n') +
      '\n\nPlease ensure all prompt files exist in your local prompts/templates/ directory, ' +
      'or in an imported package.'
    );
  }
}

/**
 * Onboarding requirements - what the user needs to configure before workflow can start
 */
export interface OnboardingNeeds {
  needsProjectName: boolean;
  needsTrackSelection: boolean;
  needsConditionsSelection: boolean;
  needsControllerSelection: boolean;
  /** @deprecated Controller is now pre-specified via controller() function */
  controllerAgents: AgentDefinition[];
  /** The loaded template for reference */
  template: WorkflowTemplate;
}

/**
 * Check what onboarding steps are needed before workflow can start
 * Does NOT throw - returns the requirements for the UI to handle
 */
export async function checkOnboardingRequired(options: { cwd?: string } = {}): Promise<OnboardingNeeds> {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const cmRoot = path.join(cwd, '.codemachine');

  // Ensure workspace structure exists
  await ensureWorkspaceStructure({ cwd });

  // Ensure imported agents are registered before loading template
  // This allows resolveStep() to find agents from imported packages
  ensureImportedAgentsRegistered();

  // Load template
  const templatePath = await getTemplatePathFromTracking(cmRoot);
  const localRoot = getDevRoot() || '';

  // Validate template exists before loading
  validateWorkflowTemplateExists(templatePath, localRoot);

  const { template } = await loadTemplateWithPath(cwd, templatePath);

  // Validate all prompt paths exist before workflow starts
  validateAllPromptPaths(template, localRoot);

  // Check existing selections
  const selectedTrack = await getSelectedTrack(cmRoot);
  const conditionsSelected = await hasSelectedConditions(cmRoot);
  const _existingProjectName = await getProjectName(cmRoot);

  // Determine what's needed
  const hasTracks = !!(template.tracks && Object.keys(template.tracks.options).length > 0);
  const hasConditionGroups = !!(template.conditionGroups && template.conditionGroups.length > 0);
  const needsTrackSelection = hasTracks && !selectedTrack;
  const needsConditionsSelection = hasConditionGroups && !conditionsSelected;
  // TODO: Re-enable project name check - temporarily disabled due to persistence bug
  const needsProjectName = false; // !_existingProjectName;

  // Controller is now pre-specified via controller() function - no selection needed
  const needsControllerSelection = false;
  const controllerAgents: AgentDefinition[] = [];

  return {
    needsProjectName,
    needsTrackSelection,
    needsConditionsSelection,
    needsControllerSelection,
    controllerAgents,
    template,
  };
}

/**
 * Check if specification file is required and valid
 * Throws ValidationError if template requires specification but it's missing/empty
 *
 * Path can be overridden via:
 * - CLI: --spec <path>
 * - Env: CODEMACHINE_SPEC_PATH
 */
export async function checkSpecificationRequired(options: { cwd?: string } = {}): Promise<void> {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const cmRoot = path.join(cwd, '.codemachine');
  const specificationPath = process.env.CODEMACHINE_SPEC_PATH
    || path.resolve(cwd, '.codemachine', 'inputs', 'specifications.md');

  // Ensure workspace structure exists
  await ensureWorkspaceStructure({ cwd });

  // Ensure imported agents are registered before loading template
  // This allows resolveStep() to find agents from imported packages
  ensureImportedAgentsRegistered();

  // Load template to check specification requirement
  const templatePath = await getTemplatePathFromTracking(cmRoot);
  const { template } = await loadTemplateWithPath(cwd, templatePath);

  // Validate specification only if template requires it
  if (template.specification === true) {
    await validateSpecification(specificationPath);
  }
}

/**
 * Main pre-flight check - verifies workflow can start
 * Throws ValidationError if workflow cannot start due to missing specification
 * Returns onboarding needs if user configuration is required
 */
export async function checkWorkflowCanStart(options: { cwd?: string } = {}): Promise<OnboardingNeeds> {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();

  // First check specification requirement (throws if invalid)
  await checkSpecificationRequired({ cwd });

  // Then check onboarding requirements (returns needs, doesn't throw)
  return checkOnboardingRequired({ cwd });
}

/**
 * Quick check if any onboarding is needed
 * Useful for UI to decide whether to show onboarding flow
 */
export function needsOnboarding(needs: OnboardingNeeds): boolean {
  return (
    needs.needsProjectName ||
    needs.needsTrackSelection ||
    needs.needsConditionsSelection ||
    needs.needsControllerSelection
  );
}
