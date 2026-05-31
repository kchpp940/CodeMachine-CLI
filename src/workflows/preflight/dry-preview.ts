import * as path from 'node:path';
import { existsSync } from 'node:fs';
import type { WorkflowTemplate, ModuleStep, WorkflowStep } from '../templates/types.js';
import { isModuleStep } from '../templates/types.js';
import { loadTemplateWithPath } from '../templates/loader.js';
import { getTemplatePathFromTracking } from '../../shared/workflows/index.js';
import { ensureWorkspaceStructure } from '../../runtime/services/workspace/index.js';
import { clearImportedAgents, registerImportedAgents } from '../utils/config.js';
import { getAllInstalledImports, resolvePromptPath } from '../../shared/imports/index.js';
import { registry, checkEngineCapabilities } from '../../infra/engines/index.js';
import type { EngineCapabilities, CapabilityValidationIssue } from '../../infra/engines/index.js';
import { collectAgentDefinitions, resolveProjectRoot } from '../../shared/agents/index.js';
import { loadChainedPrompts } from '../../agents/runner/chained.js';
import type { ChainedPathEntry } from '../../shared/agents/config/types.js';
import { getSelectedConditions, getSelectedTrack } from '../../shared/workflows/template.js';
import { getDevRoot } from '../../shared/runtime/dev.js';
import { debug } from '../../shared/logging/logger.js';

const localRoot = getDevRoot() || '';

export class DryPreviewError extends Error {
  public readonly errors: DryPreviewIssue[];
  public readonly warnings: DryPreviewIssue[];

  constructor(message: string, errors: DryPreviewIssue[], warnings: DryPreviewIssue[] = []) {
    super(message);
    this.name = 'DryPreviewError';
    this.errors = errors;
    this.warnings = warnings;
  }
}

export type IssueSeverity = 'error' | 'warning';

export interface DryPreviewIssue {
  severity: IssueSeverity;
  stepIndex?: number;
  agentId?: string;
  category: 'missing-prompt' | 'missing-agent' | 'engine-mismatch' | 'path-conflict' | 'missing-chained-prompt' | 'missing-engine' | 'model-unsupported' | 'other';
  message: string;
  detail?: string;
}

export interface ImportSourceInfo {
  name: string;
  version: string;
  source: string;
  resolvedPaths: {
    config: string;
    workflows: string;
    prompts: string;
    characters: string;
  };
}

export interface ChainedPromptPreview {
  name: string;
  label: string;
  resolvedPath: string;
  exists: boolean;
}

export interface StepPreview {
  stepIndex: number;
  type: 'module' | 'separator';
  agentId?: string;
  agentName?: string;
  promptPath?: string | string[];
  resolvedPromptPaths?: string[];
  promptExists?: boolean[];
  engine?: string;
  resolvedEngine?: string;
  model?: string;
  resolvedModel?: string;
  modelReasoningEffort?: 'low' | 'medium' | 'high';
  agentConfigFound?: boolean;
  agentConfigSource?: string;
  chainedPrompts?: ChainedPromptPreview[];
  chainedPromptsPath?: ChainedPathEntry | ChainedPathEntry[];
  module?: {
    id: string;
    behavior?: string;
  };
  tracks?: string[];
  conditions?: string[];
  conditionsAny?: string[];
  interactive?: boolean;
  executeOnce?: boolean;
}

export interface ControllerPreview {
  agentId: string;
  engine?: string;
  model?: string;
  resolvedEngine?: string;
  resolvedModel?: string;
}

export interface DryPreviewResult {
  templateName: string;
  templatePath: string;
  specification: boolean;
  autonomousMode?: 'true' | 'false' | 'never' | 'always';
  selectedTrack: string | null;
  selectedConditions: string[];
  imports: ImportSourceInfo[];
  controller?: ControllerPreview;
  steps: StepPreview[];
  issues: DryPreviewIssue[];
  valid: boolean;
}

function ensureImportedAgentsRegistered(): void {
  clearImportedAgents();
  const importedPackages = getAllInstalledImports();
  for (const imp of importedPackages) {
    registerImportedAgents(imp.resolvedPaths.config);
  }
}

function resolveStepPromptPaths(promptPath: string | string[], cwd: string): { resolved: string[]; exists: boolean[] } {
  const paths = Array.isArray(promptPath) ? promptPath : [promptPath];
  const resolved: string[] = [];
  const exists: boolean[] = [];

  for (const p of paths) {
    if (path.isAbsolute(p)) {
      resolved.push(p);
      exists.push(existsSync(p));
    } else {
      const importResolved = resolvePromptPath(p, localRoot);
      if (importResolved) {
        resolved.push(importResolved);
        exists.push(true);
      } else {
        const localResolved = path.resolve(cwd, p);
        resolved.push(localResolved);
        exists.push(existsSync(localResolved));
      }
    }
  }

  return { resolved, exists };
}

function detectPathConflicts(steps: StepPreview[]): DryPreviewIssue[] {
  const issues: DryPreviewIssue[] = [];
  const pathToSteps = new Map<string, { stepIndex: number; agentId: string }[]>();

  for (const step of steps) {
    if (step.type !== 'module' || !step.resolvedPromptPaths) continue;
    for (const rp of step.resolvedPromptPaths) {
      if (!pathToSteps.has(rp)) {
        pathToSteps.set(rp, []);
      }
      pathToSteps.get(rp)!.push({ stepIndex: step.stepIndex, agentId: step.agentId! });
    }
  }

  for (const [resolvedPath, entries] of pathToSteps) {
    if (entries.length > 1) {
      issues.push({
        severity: 'warning',
        category: 'path-conflict',
        message: `Prompt path "${resolvedPath}" is referenced by multiple steps`,
        detail: `Steps: ${entries.map(e => `#${e.stepIndex} (${e.agentId})`).join(', ')}`,
      });
    }
  }

  return issues;
}

async function resolveAgentConfigForStep(agentId: string, cwd: string): Promise<{ found: boolean; source?: string; config?: Record<string, unknown> }> {
  try {
    const resolvedRoot = resolveProjectRoot(cwd);
    const agents = await collectAgentDefinitions(resolvedRoot);
    const agent = agents.find(a => a.id === agentId);
    if (agent) {
      const source = 'catalog';
      return { found: true, source, config: agent as unknown as Record<string, unknown> };
    }
  } catch {
    // ignore
  }
  return { found: false };
}

function resolveEngineForStep(step: ModuleStep): { engineId: string; engineFound: boolean; engineAuthenticated: boolean; fallbackUsed: boolean } {
  const engines = registry.getAll();
  const defaultEngine = registry.getDefault();

  if (step.engine) {
    const engineModule = registry.get(step.engine);
    if (engineModule) {
      return { engineId: step.engine, engineFound: true, engineAuthenticated: false, fallbackUsed: false };
    }
    if (defaultEngine) {
      return { engineId: defaultEngine.metadata.id, engineFound: false, engineAuthenticated: false, fallbackUsed: true };
    }
    return { engineId: step.engine, engineFound: false, engineAuthenticated: false, fallbackUsed: false };
  }

  if (defaultEngine) {
    return { engineId: defaultEngine.metadata.id, engineFound: true, engineAuthenticated: false, fallbackUsed: false };
  }

  return { engineId: 'unknown', engineFound: false, engineAuthenticated: false, fallbackUsed: false };
}

function resolveModelForStep(step: ModuleStep, engineId: string): string | undefined {
  if (step.model) return step.model;
  const engineModule = registry.get(engineId);
  return engineModule?.metadata.defaultModel;
}

function capabilityToPreviewIssues(
  capIssues: CapabilityValidationIssue[],
  stepIndex: number,
  agentId: string,
): DryPreviewIssue[] {
  return capIssues.map(issue => {
    const category: DryPreviewIssue['category'] =
      issue.capability === 'supportedModels' ? 'model-unsupported' :
      issue.capability === 'supportsModelOverride' ? 'model-unsupported' :
      'engine-mismatch';
    return {
      severity: 'error',
      stepIndex,
      agentId,
      category,
      message: `Step #${stepIndex} (${agentId}): ${issue.message}`,
      detail: issue.supportedValues
        ? `Supported values: ${issue.supportedValues.join(', ')}`
        : undefined,
    };
  });
}

export async function dryPreview(options: { cwd?: string } = {}): Promise<DryPreviewResult> {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const cmRoot = path.join(cwd, '.codemachine');

  await ensureWorkspaceStructure({ cwd });
  ensureImportedAgentsRegistered();

  const templatePath = await getTemplatePathFromTracking(cmRoot);
  const { template, resolvedPath } = await loadTemplateWithPath(cwd, templatePath);

  const importedPackages = getAllInstalledImports();
  const imports: ImportSourceInfo[] = importedPackages.map(imp => ({
    name: imp.name,
    version: imp.version,
    source: imp.source,
    resolvedPaths: imp.resolvedPaths,
  }));

  const selectedTrack = await getSelectedTrack(cmRoot);
  const selectedConditions = await getSelectedConditions(cmRoot);

  const issues: DryPreviewIssue[] = [];
  const stepPreviews: StepPreview[] = [];

  const visibleSteps = template.steps.filter((step) => {
    if (step.type === 'separator') return true;
    if (isModuleStep(step)) {
      if (step.tracks?.length && selectedTrack && !step.tracks.includes(selectedTrack)) return false;
      const selected = selectedConditions ?? [];
      if (step.conditions?.length) {
        const missing = step.conditions.filter(c => !selected.includes(c));
        if (missing.length > 0) return false;
      }
      if (step.conditionsAny?.length) {
        const matched = step.conditionsAny.some(c => selected.includes(c));
        if (!matched) return false;
      }
    }
    return true;
  });

  for (let idx = 0; idx < visibleSteps.length; idx++) {
    const step = visibleSteps[idx];

    if (step.type === 'separator') {
      stepPreviews.push({ stepIndex: idx, type: 'separator' });
      continue;
    }

    if (!isModuleStep(step)) continue;

    const stepPreview: StepPreview = {
      stepIndex: idx,
      type: 'module',
      agentId: step.agentId,
      agentName: step.agentName,
      promptPath: step.promptPath,
      engine: step.engine,
      model: step.model,
      modelReasoningEffort: step.modelReasoningEffort,
      module: step.module ? { id: step.module.id, behavior: step.module.behavior?.type } : undefined,
      tracks: step.tracks,
      conditions: step.conditions,
      conditionsAny: step.conditionsAny,
      interactive: step.interactive,
      executeOnce: step.executeOnce,
    };

    // Resolve prompt paths
    if (step.promptPath) {
      const { resolved, exists } = resolveStepPromptPaths(step.promptPath, cwd);
      stepPreview.resolvedPromptPaths = resolved;
      stepPreview.promptExists = exists;

      const missingIndices = exists.map((e, i) => !e ? i : -1).filter(i => i >= 0);
      if (missingIndices.length > 0) {
        const missingPaths = missingIndices.map(i => resolved[i]);
        issues.push({
          severity: 'error',
          stepIndex: idx,
          agentId: step.agentId,
          category: 'missing-prompt',
          message: `Step #${idx} (${step.agentId}): prompt path not found`,
          detail: `Missing: ${missingPaths.join(', ')}`,
        });
      }
    } else {
      issues.push({
        severity: 'error',
        stepIndex: idx,
        agentId: step.agentId,
        category: 'missing-prompt',
        message: `Step #${idx} (${step.agentId}): no promptPath configured`,
      });
    }

    // Resolve agent config
    const agentConfigResult = await resolveAgentConfigForStep(step.agentId, cwd);
    stepPreview.agentConfigFound = agentConfigResult.found;
    stepPreview.agentConfigSource = agentConfigResult.source;

    if (!agentConfigResult.found) {
      issues.push({
        severity: 'warning',
        stepIndex: idx,
        agentId: step.agentId,
        category: 'missing-agent',
        message: `Step #${idx} (${step.agentId}): agent config not found in catalog`,
        detail: 'The agent ID has no matching configuration in any agents module. Default behavior will be used.',
      });
    }

    // Resolve engine
    const engineResult = resolveEngineForStep(step);
    stepPreview.resolvedEngine = engineResult.engineId;

    if (!engineResult.engineFound && step.engine) {
      issues.push({
        severity: 'error',
        stepIndex: idx,
        agentId: step.agentId,
        category: 'engine-mismatch',
        message: `Step #${idx} (${step.agentId}): engine "${step.engine}" is not registered`,
        detail: `Available engines: ${registry.getAllIds().join(', ') || '(none)'}`,
      });
    } else if (engineResult.fallbackUsed) {
      issues.push({
        severity: 'warning',
        stepIndex: idx,
        agentId: step.agentId,
        category: 'engine-mismatch',
        message: `Step #${idx} (${step.agentId}): engine "${step.engine}" not found, falling back to "${engineResult.engineId}"`,
      });
    }

    if (registry.getAllIds().length === 0) {
      issues.push({
        severity: 'error',
        stepIndex: idx,
        agentId: step.agentId,
        category: 'missing-engine',
        message: `No engines registered. At least one engine is required to run the workflow.`,
      });
    }

    const resolvedModel = resolveModelForStep(step, engineResult.engineId);
    stepPreview.resolvedModel = resolvedModel;

    if (engineResult.engineFound) {
      const requirements: Partial<EngineCapabilities> & { model?: string } = { model: step.model };
      if (step.modelReasoningEffort) {
        requirements.supportsReasoningEffort = true;
      }
      const capIssues = checkEngineCapabilities(engineResult.engineId, requirements);
      issues.push(...capabilityToPreviewIssues(capIssues, idx, step.agentId));
    }

    // Resolve chained prompts
    if (agentConfigResult.found && agentConfigResult.config) {
      const agentDef = agentConfigResult.config as { chainedPromptsPath?: ChainedPathEntry | ChainedPathEntry[] };
      if (agentDef.chainedPromptsPath) {
        stepPreview.chainedPromptsPath = agentDef.chainedPromptsPath;

        try {
          const chainedPrompts = await loadChainedPrompts(
            agentDef.chainedPromptsPath,
            cwd,
            selectedConditions ?? [],
            selectedTrack,
          );

          stepPreview.chainedPrompts = chainedPrompts.map(cp => ({
            name: cp.name,
            label: cp.label,
            resolvedPath: cp.name,
            exists: cp.content.length > 0,
          }));

          if (chainedPrompts.length === 0) {
            issues.push({
              severity: 'warning',
              stepIndex: idx,
              agentId: step.agentId,
              category: 'missing-chained-prompt',
              message: `Step #${idx} (${step.agentId}): chainedPromptsPath configured but no .md prompts resolved`,
              detail: `Path: ${JSON.stringify(agentDef.chainedPromptsPath)}`,
            });
          }
        } catch (err) {
          issues.push({
            severity: 'warning',
            stepIndex: idx,
            agentId: step.agentId,
            category: 'missing-chained-prompt',
            message: `Step #${idx} (${step.agentId}): failed to load chained prompts`,
            detail: (err as Error).message,
          });
        }
      }
    }

    stepPreviews.push(stepPreview);
  }

  // Detect path conflicts
  const conflictIssues = detectPathConflicts(stepPreviews);
  issues.push(...conflictIssues);

  let controllerPreview: ControllerPreview | undefined;
  const ctrl = template.controller;
  if (ctrl) {
    controllerPreview = {
      agentId: ctrl.agentId,
      engine: ctrl.options?.engine,
      model: ctrl.options?.model,
    };

    if (ctrl.options?.engine) {
      const ctrlEngine = registry.get(ctrl.options.engine);
      controllerPreview.resolvedEngine = ctrlEngine
        ? ctrl.options.engine
        : (registry.getDefault()?.metadata.id ?? 'unknown');

      if (!ctrlEngine) {
        issues.push({
          severity: 'error',
          category: 'engine-mismatch',
          agentId: ctrl.agentId,
          message: `Controller engine "${ctrl.options.engine}" is not registered`,
          detail: `Available engines: ${registry.getAllIds().join(', ') || '(none)'}`,
        });
      } else {
        const requirements: Partial<EngineCapabilities> & { model?: string } = { model: ctrl.options.model };
        const capIssues = checkEngineCapabilities(ctrl.options.engine, requirements);
        issues.push(...capIssues.map(issue => ({
          severity: 'error' as const,
          category: (issue.capability === 'supportedModels' || issue.capability === 'supportsModelOverride') ? 'model-unsupported' as const : 'engine-mismatch' as const,
          agentId: ctrl.agentId,
          message: `Controller: ${issue.message}`,
          detail: issue.supportedValues ? `Supported values: ${issue.supportedValues.join(', ')}` : undefined,
        })));
      }
    } else {
      controllerPreview.resolvedEngine = registry.getDefault()?.metadata.id ?? 'unknown';
    }

    controllerPreview.resolvedModel = ctrl.options?.model
      ?? registry.get(controllerPreview.resolvedEngine)?.metadata.defaultModel;
  }

  const errors = issues.filter(i => i.severity === 'error');
  const valid = errors.length === 0;

  if (!valid) {
    debug('[DryPreview] Validation failed with %d errors, %d warnings', errors.length, issues.length - errors.length);
  } else {
    debug('[DryPreview] Validation passed with %d warnings', issues.filter(i => i.severity === 'warning').length);
  }

  return {
    templateName: template.name,
    templatePath: resolvedPath,
    specification: template.specification === true,
    autonomousMode: template.autonomousMode,
    selectedTrack,
    selectedConditions: selectedConditions ?? [],
    imports,
    controller: controllerPreview,
    steps: stepPreviews,
    issues,
    valid,
  };
}

export function formatDryPreviewResult(result: DryPreviewResult): string {
  const lines: string[] = [];

  lines.push('╔══════════════════════════════════════════════════════════╗');
  lines.push('║             WORKFLOW DRY PREVIEW                         ║');
  lines.push('╚══════════════════════════════════════════════════════════╝');
  lines.push('');

  lines.push(`  Template:     ${result.templateName}`);
  lines.push(`  Path:         ${result.templatePath}`);
  lines.push(`  Specification: ${result.specification ? 'required' : 'not required'}`);
  if (result.autonomousMode) {
    lines.push(`  Auto Mode:    ${result.autonomousMode}`);
  }
  if (result.selectedTrack) {
    lines.push(`  Track:        ${result.selectedTrack}`);
  }
  if (result.selectedConditions.length > 0) {
    lines.push(`  Conditions:   ${result.selectedConditions.join(', ')}`);
  }
  lines.push('');

  // Imports
  if (result.imports.length > 0) {
    lines.push('  ── Import Sources ──────────────────────────────────────');
    for (const imp of result.imports) {
      lines.push(`  📦 ${imp.name} v${imp.version} (${imp.source})`);
      lines.push(`     prompts:   ${imp.resolvedPaths.prompts}`);
      lines.push(`     workflows: ${imp.resolvedPaths.workflows}`);
      lines.push(`     config:    ${imp.resolvedPaths.config}`);
    }
    lines.push('');
  }

  // Controller
  if (result.controller) {
    lines.push('  ── Controller ─────────────────────────────────────────');
    lines.push(`  Agent:  ${result.controller.agentId}`);
    lines.push(`  Engine: ${result.controller.resolvedEngine ?? '(default)'}${result.controller.engine && result.controller.engine !== result.controller.resolvedEngine ? ` (requested: ${result.controller.engine})` : ''}`);
    lines.push(`  Model:  ${result.controller.resolvedModel ?? '(engine default)'}`);
    lines.push('');
  }

  // Steps
  lines.push('  ── Steps ──────────────────────────────────────────────');
  for (const step of result.steps) {
    if (step.type === 'separator') {
      lines.push('');
      lines.push(`  ── ${'─'.repeat(40)}`);
      continue;
    }

    const missing = step.promptExists?.some(e => !e);
    const marker = missing ? '❌' : '✓';
    lines.push(`  ${marker} Step #${step.stepIndex}: ${step.agentName ?? step.agentId}`);
    lines.push(`     Agent:    ${step.agentId} ${step.agentConfigFound ? '' : '(⚠ not in catalog)'}`);

    if (step.resolvedPromptPaths) {
      for (let i = 0; i < step.resolvedPromptPaths.length; i++) {
        const exists = step.promptExists?.[i] ?? false;
        lines.push(`     Prompt:   ${step.resolvedPromptPaths[i]} ${exists ? '' : '(❌ missing)'}`);
      }
    }

    lines.push(`     Engine:   ${step.resolvedEngine ?? '(default)'}${step.engine && step.engine !== step.resolvedEngine ? ` (requested: ${step.engine})` : ''}`);
    lines.push(`     Model:    ${step.resolvedModel ?? '(engine default)'}`);
    if (step.modelReasoningEffort) {
      lines.push(`     Effort:   ${step.modelReasoningEffort}`);
    }

    if (step.chainedPrompts && step.chainedPrompts.length > 0) {
      lines.push(`     Chained:  ${step.chainedPrompts.length} prompts`);
      for (const cp of step.chainedPrompts) {
        lines.push(`       - ${cp.name}: ${cp.label}`);
      }
    }

    if (step.module) {
      lines.push(`     Module:   ${step.module.id}${step.module.behavior ? ` (${step.module.behavior})` : ''}`);
    }
  }

  // Issues
  if (result.issues.length > 0) {
    lines.push('');
    lines.push('  ── Issues ─────────────────────────────────────────────');

    const errors = result.issues.filter(i => i.severity === 'error');
    const warnings = result.issues.filter(i => i.severity === 'warning');

    for (const err of errors) {
      const loc = err.stepIndex !== undefined ? `Step #${err.stepIndex}` : 'General';
      lines.push(`  ❌ [${loc}] ${err.message}`);
      if (err.detail) lines.push(`     ${err.detail}`);
    }

    for (const warn of warnings) {
      const loc = warn.stepIndex !== undefined ? `Step #${warn.stepIndex}` : 'General';
      lines.push(`  ⚠  [${loc}] ${warn.message}`);
      if (warn.detail) lines.push(`     ${warn.detail}`);
    }
  }

  lines.push('');
  if (result.valid) {
    lines.push('  ✅ Workflow is valid and ready to execute.');
  } else {
    lines.push('  🚫 Workflow has errors that must be resolved before execution.');
  }

  return lines.join('\n');
}
