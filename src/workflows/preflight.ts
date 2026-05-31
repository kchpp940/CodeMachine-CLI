/**
 * Workflow Pre-flight Checks
 *
 * Consolidates all checks that must pass before a workflow can start.
 * Single source of truth for workflow startup validation.
 *
 * runDryPreview() returns a complete PreviewResult including:
 *   - Onboarding requirements
 *   - Import package information
 *   - Agent configurations (engine, model, prompt paths)
 *   - Trigger chain analysis
 *   - Blocking issues (errors/warnings)
 *
 * Gateway consumes this result directly — no duplicate analysis.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { WorkflowTemplate, ModuleStep } from './templates/types.js';
import { loadTemplateWithPath } from './templates/loader.js';
import { getTemplatePathFromTracking, getSelectedTrack, hasSelectedConditions, getSelectedConditions, getProjectName } from '../shared/workflows/index.js';
import { validateSpecification } from '../runtime/services/index.js';
import { ensureWorkspaceStructure } from '../runtime/services/workspace/index.js';
import type { AgentDefinition } from '../shared/agents/config/types.js';
import { registerImportedAgents, clearImportedAgents } from './utils/config.js';
import { getAllInstalledImports } from '../shared/imports/index.js';
import { registry } from '../infra/engines/index.js';
import type { InstalledImport } from '../shared/imports/types.js';

export { ValidationError } from '../runtime/services/index.js';

export interface PreviewImport {
  name: string;
  version: string;
  source: string;
}

export interface PreviewAgent {
  agentId: string;
  agentName: string;
  promptPath: string[];
  engine: string;
  model: string;
  modelReasoningEffort?: 'low' | 'medium' | 'high';
  isInteractive?: boolean;
  tracks?: string[];
  conditions?: string[];
  conditionsAny?: string[];
  moduleBehavior?: string;
  stepIndex: number;
  moduleIndex: number;
}

export interface PreviewChain {
  name: string;
  triggerAgent: string;
  targetAgent: string;
}

export interface PreviewBlockingIssue {
  type: 'error' | 'warning';
  message: string;
  step?: number;
  agentId?: string;
}

export interface PreviewResult {
  onboardingNeeds: OnboardingNeeds;
  template: WorkflowTemplate;
  templatePath: string;
  needsOnboarding: boolean;
  specPath: string | null;
  imports: PreviewImport[];
  agents: PreviewAgent[];
  subAgents: string[];
  chains: PreviewChain[];
  blockingIssues: PreviewBlockingIssue[];
  hasErrors: boolean;
}

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
  const { template } = await loadTemplateWithPath(cwd, templatePath);

  // Check existing selections
  const selectedTrack = await getSelectedTrack(cmRoot);
  const conditionsSelected = await hasSelectedConditions(cmRoot);
  const existingProjectName = await getProjectName(cmRoot);

  // Determine what's needed
  const hasTracks = !!(template.tracks && Object.keys(template.tracks.options).length > 0);
  const hasConditionGroups = !!(template.conditionGroups && template.conditionGroups.length > 0);
  const needsTrackSelection = hasTracks && !selectedTrack;
  const needsConditionsSelection = hasConditionGroups && !conditionsSelected;
  // TODO: Re-enable project name check - temporarily disabled due to persistence bug
  const needsProjectName = false; // !existingProjectName;

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

/**
 * Run a complete dry preview of the workflow.
 * Returns the full PreviewResult that ConfirmPreview consumes directly.
 * This is the single source of truth for dry preview data — gateway and UI
 * both use this result, no duplicate analysis.
 */
export async function runDryPreview(options: { cwd?: string } = {}): Promise<PreviewResult> {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const cmRoot = path.join(cwd, '.codemachine');
  const blockingIssues: PreviewBlockingIssue[] = [];

  try {
    await checkSpecificationRequired({ cwd });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    blockingIssues.push({
      type: 'error',
      message: err.message,
    });
  }

  const templatePath = await getTemplatePathFromTracking(cmRoot);
  const onboardingNeeds = await checkOnboardingRequired({ cwd });
  const { template } = onboardingNeeds;
  const needsOB = needsOnboarding(onboardingNeeds);

  const specPath = template.specification
    ? process.env.CODEMACHINE_SPEC_PATH || path.resolve(cwd, '.codemachine', 'inputs', 'specifications.md')
    : null;

  const imports = collectImports();
  const { agents, chains, issues } = await analyzeTemplate(cwd, template);
  blockingIssues.push(...issues);

  const subAgents = template.subAgentIds || [];
  const hasErrors = blockingIssues.some(i => i.type === 'error');

  return {
    onboardingNeeds,
    template,
    templatePath,
    needsOnboarding: needsOB,
    specPath,
    imports,
    agents,
    subAgents,
    chains,
    blockingIssues,
    hasErrors,
  };
}

function collectImports(): PreviewImport[] {
  const packages = getAllInstalledImports();
  return packages.map((pkg: InstalledImport): PreviewImport => ({
    name: pkg.name,
    version: pkg.version || 'unknown',
    source: pkg.source,
  }));
}

async function analyzeTemplate(
  cwd: string,
  template: WorkflowTemplate,
): Promise<{ agents: PreviewAgent[]; chains: PreviewChain[]; issues: PreviewBlockingIssue[] }> {
  const cmRoot = path.join(cwd, '.codemachine');
  let selectedTrack: string | null = null;
  let selectedConditions: string[] = [];

  try {
    selectedTrack = await getSelectedTrack(cmRoot);
    selectedConditions = await getSelectedConditions(cmRoot) || [];
  } catch {
  }

  const agents: PreviewAgent[] = [];
  const chains: PreviewChain[] = [];
  const issues: PreviewBlockingIssue[] = [];

  let moduleIndex = 0;
  const agentIds = new Set<string>();

  for (let stepIndex = 0; stepIndex < template.steps.length; stepIndex++) {
    const step = template.steps[stepIndex];
    if (step.type !== 'module') continue;

    if (step.tracks?.length && selectedTrack && !step.tracks.includes(selectedTrack)) {
      continue;
    }

    if (step.conditions?.length) {
      const missing = step.conditions.filter(c => !selectedConditions.includes(c));
      if (missing.length > 0) {
        continue;
      }
    }

    if (step.conditionsAny?.length) {
      const matched = step.conditionsAny.some(c => selectedConditions.includes(c));
      if (!matched) {
        continue;
      }
    }

    if (agentIds.has(step.agentId)) {
      issues.push({
        type: 'warning',
        message: `Duplicate agent ID: ${step.agentId} (step ${stepIndex})`,
        step: stepIndex,
        agentId: step.agentId,
      });
    }
    agentIds.add(step.agentId);

    const defaultEngine = registry.getDefault();
    const engineType = step.engine ?? defaultEngine?.metadata.id ?? 'unknown';
    const engineModule = registry.get(engineType);
    const resolvedModel = step.model ?? engineModule?.metadata.defaultModel ?? 'default';

    if (!registry.get(engineType)) {
      issues.push({
        type: 'error',
        message: `Engine '${engineType}' not found in registry for agent '${step.agentId}'`,
        step: stepIndex,
        agentId: step.agentId,
      });
    }

    const promptPaths = Array.isArray(step.promptPath) ? step.promptPath : [step.promptPath];
    for (const p of promptPaths) {
      const fullPath = path.resolve(cwd, p);
      try {
        if (!fs.existsSync(fullPath)) {
          issues.push({
            type: 'error',
            message: `Prompt file not found: ${p}`,
            step: stepIndex,
            agentId: step.agentId,
          });
        }
      } catch {
      }
    }

    if (step.module?.behavior) {
      if (step.module.behavior.type === 'trigger') {
        const targetId = step.module.behavior.triggerAgentId;
        chains.push({
          name: `${step.agentId} → ${targetId}`,
          triggerAgent: step.agentId,
          targetAgent: targetId,
        });
      } else if (step.module.behavior.type === 'loop') {
        const loopSteps = step.module.behavior.steps || 1;
        if (loopSteps > moduleIndex) {
          issues.push({
            type: 'warning',
            message: `Loop behavior steps back ${loopSteps} but only ${moduleIndex} prior steps exist`,
            step: stepIndex,
            agentId: step.agentId,
          });
        }
      }
    }

    agents.push({
      agentId: step.agentId,
      agentName: step.agentName || step.agentId,
      promptPath: promptPaths,
      engine: engineType,
      model: resolvedModel,
      modelReasoningEffort: step.modelReasoningEffort,
      isInteractive: step.interactive,
      tracks: step.tracks,
      conditions: step.conditions,
      conditionsAny: step.conditionsAny,
      moduleBehavior: step.module?.behavior?.type,
      stepIndex,
      moduleIndex,
    });

    moduleIndex++;
  }

  return { agents, chains, issues };
}

