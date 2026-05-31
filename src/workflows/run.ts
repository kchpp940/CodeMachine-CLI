/**
 * Workflow Runner Entry Point
 *
 * Architecture:
 * - State machine for state management
 * - Input providers for input sources
 * - Clean separation of concerns
 */

import * as path from 'node:path';

import type { RunWorkflowOptions, WorkflowStep, WorkflowTemplate } from './templates/types.js';
import { loadTemplateWithPath } from './templates/index.js';
import { debug, setDebugLogFile } from '../shared/logging/logger.js';
import {
  getTemplatePathFromTracking,
  getSelectedTrack,
  getSelectedConditions,
  getControllerView,
  loadControllerConfig,
  saveControllerConfig,
  setActiveTemplate,
} from '../shared/workflows/index.js';
import { StepIndexManager } from './indexing/index.js';
import { registry } from '../infra/engines/index.js';
import { MonitoringCleanup, AgentMonitorService, StatusService } from '../agents/monitoring/index.js';
import { WorkflowEventBus, WorkflowEventEmitter } from './events/index.js';
import { ensureWorkspaceStructure, mirrorSubAgents } from '../runtime/services/workspace/index.js';
import { WorkflowRunner } from './runner/index.js';
import { getUniqueAgentId } from './context/index.js';
import { runControllerView } from './controller/view.js';
import { getAllInstalledImports } from '../shared/imports/index.js';
import { registerImportedAgents, clearImportedAgents } from './utils/config.js';
import { generateRecoveryPlan, formatRecoveryPlan } from './recovery/index.js';
import type { RecoveryPlanState } from '../cli/tui/routes/workflow/state/types.js';
import type { RecoveryPlan } from './recovery/types.js';

// Re-export from preflight for backward compatibility
export { ValidationError, checkWorkflowCanStart, checkSpecificationRequired, checkOnboardingRequired, needsOnboarding } from './preflight.js';
export type { WorkflowStep, WorkflowTemplate };

/**
 * Run a workflow
 * Note: Pre-flight checks (specification validation) should be done via preflight.ts before calling this
 */
export async function runWorkflow(options: RunWorkflowOptions = {}): Promise<void> {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();

  // Ensure workspace structure exists (creates .codemachine folder tree)
  await ensureWorkspaceStructure({ cwd });

  // Auto-register agents from all installed imports
  // This ensures imported agents/modules are available before template loading
  clearImportedAgents();
  const importedPackages = getAllInstalledImports();
  for (const imp of importedPackages) {
    registerImportedAgents(imp.resolvedPaths.config);
  }
  debug('[Workflow] Registered agents from %d imported packages', importedPackages.length);

  // Load template
  const cmRoot = path.join(cwd, '.codemachine');
  const templatePath = options.templatePath || (await getTemplatePathFromTracking(cmRoot));
  const { template } = await loadTemplateWithPath(cwd, templatePath);

  // Ensure template.json exists with correct activeTemplate before any setter functions are called
  // This prevents setControllerView/setSelectedTrack/etc from creating file with empty activeTemplate
  const templateFileName = path.basename(templatePath);
  await setActiveTemplate(cmRoot, templateFileName, template.autonomousMode);

  // Clear screen for TUI
  if (process.stdout.isTTY) {
    process.stdout.write('\x1b[2J\x1b[H');
  }

  // Redirect debug logs to file
  const rawLogLevel = (process.env.LOG_LEVEL || '').trim().toLowerCase();
  const debugFlag = (process.env.DEBUG || '').trim().toLowerCase();
  const debugEnabled = rawLogLevel === 'debug' || (debugFlag !== '' && debugFlag !== '0' && debugFlag !== 'false');
  const debugLogPath = debugEnabled ? path.join(cwd, '.codemachine', 'logs', 'workflow-debug.log') : null;
  setDebugLogFile(debugLogPath);

  // Set up cleanup handlers
  MonitoringCleanup.setup();

  // Initialize index manager for step tracking
  const indexManager = new StepIndexManager(cmRoot);

  // Register callback to save session state before cleanup on Ctrl+C
  // This ensures session/monitoring IDs are persisted even if the first turn hasn't completed
  MonitoringCleanup.registerWorkflowHandlers({
    onBeforeCleanup: async () => {
      // Check if we're in controller view - controller session goes to controllerConfig, not completedSteps
      const isInControllerView = await getControllerView(cmRoot);

      const monitor = AgentMonitorService.getInstance();
      const activeAgents = monitor.getActiveAgents();

      // Find root agents (no parentId) - these are the main step/controller agents
      const rootAgents = activeAgents.filter((agent) => !agent.parentId);

      for (const agent of rootAgents) {
        // Only save if agent has a sessionId (needed for resume)
        if (agent.sessionId) {
          if (isInControllerView) {
            // Save to controllerConfig (controller's own section)
            const existingConfig = await loadControllerConfig(cmRoot);
            if (existingConfig?.controllerConfig?.agentId) {
              debug('[Workflow] Saving controller session on Ctrl+C: agentId=%s, sessionId=%s, monitoringId=%d',
                existingConfig.controllerConfig.agentId, agent.sessionId, agent.id);
              await saveControllerConfig(cmRoot, {
                agentId: existingConfig.controllerConfig.agentId,
                sessionId: agent.sessionId,
                monitoringId: agent.id,
              }, existingConfig.autonomousMode);
            }
          } else {
            // Save to completedSteps (normal step agent)
            const stepIndex = indexManager.currentStepIndex;
            debug('[Workflow] Saving session state on Ctrl+C: step=%d, sessionId=%s, monitoringId=%d',
              stepIndex, agent.sessionId, agent.id);
            await indexManager.stepSessionInitialized(stepIndex, agent.sessionId, agent.id);
          }
        }
      }
    },
  });

  debug('[Workflow] Using template: %s', template.name);

  // Mirror sub-agents if template has subAgentIds
  if (template.subAgentIds && template.subAgentIds.length > 0) {
    debug('[Workflow] Mirroring %d sub-agents', template.subAgentIds.length);
    await mirrorSubAgents({ cwd, subAgentIds: template.subAgentIds });
  }

  // Sync agent configurations
  const workflowAgents = Array.from(
    template.steps
      .filter((step) => step.type === 'module')
      .reduce((acc, step) => {
        const id = step.agentId?.trim();
        if (!id) return acc;
        const existing = acc.get(id) ?? { id };
        acc.set(id, {
          ...existing,
          id,
          model: step.model ?? existing.model,
          modelReasoningEffort: step.modelReasoningEffort ?? existing.modelReasoningEffort,
        });
        return acc;
      }, new Map<string, { id: string; model?: unknown; modelReasoningEffort?: unknown }>()).values(),
  );

  if (workflowAgents.length > 0) {
    const engines = registry.getAll();
    for (const engine of engines) {
      if (engine.syncConfig) {
        await engine.syncConfig({ additionalAgents: workflowAgents });
      }
    }
  }

  // Get event bus
  // @ts-expect-error - global export from app.tsx
  const eventBus: WorkflowEventBus = globalThis.__workflowEventBus ?? new WorkflowEventBus();
  const emitter = new WorkflowEventEmitter(eventBus);

  // @ts-expect-error - global export
  if (!globalThis.__workflowEventBus) {
    // @ts-expect-error - global export
    globalThis.__workflowEventBus = eventBus;
  }

  // Initialize status coordinator
  const status = StatusService.getInstance();
  status.setEmitter(emitter);

  // Get resume info (used as input to recovery plan generation, NOT as the final start index)
  const resumeInfo = await indexManager.getResumeInfo();
  debug('[Workflow] ========== STEP DECISION ==========');
  debug('[Workflow] Resume info: startIndex=%d, decision=%s', resumeInfo.startIndex, resumeInfo.decision);

  // Load track and conditions selections
  const selectedTrack = await getSelectedTrack(cmRoot);
  const selectedConditions = await getSelectedConditions(cmRoot);
  debug('[Workflow] selectedTrack: %s', selectedTrack);
  debug('[Workflow] selectedConditions: %O', selectedConditions);

  // Filter steps by track and conditions
  debug('[Workflow] Filtering %d template steps...', template.steps.length);
  const visibleSteps = template.steps.filter((step, idx) => {
    // Separators are always included (visual dividers only)
    if (step.type === 'separator') {
      debug('[Workflow] Step %d: type=separator → included (visual separator)', idx);
      return true;
    }
    // Module steps may be filtered by track/conditions
    if (step.tracks?.length && selectedTrack && !step.tracks.includes(selectedTrack)) {
      debug('[Workflow] Step %d: agentId=%s, tracks=%O, selectedTrack=%s → EXCLUDED (track mismatch)',
        idx, step.agentId, step.tracks, selectedTrack);
      return false;
    }
    const selected = selectedConditions ?? [];
    if (step.conditions?.length) {
      const missing = step.conditions.filter(c => !selected.includes(c));
      if (missing.length > 0) {
        debug('[Workflow] Step %d: agentId=%s, conditions=%O, missing=%O → EXCLUDED (missing conditions)',
          idx, step.agentId, step.conditions, missing);
        return false;
      }
    }
    if (step.conditionsAny?.length) {
      const matched = step.conditionsAny.some(c => selected.includes(c));
      if (!matched) {
        debug('[Workflow] Step %d: agentId=%s, conditionsAny=%O → EXCLUDED (no match)',
          idx, step.agentId, step.conditionsAny);
        return false;
      }
    }
    debug('[Workflow] Step %d: agentId=%s → included', idx, step.agentId);
    return true;
  });
  debug('[Workflow] Visible steps after filtering: %d', visibleSteps.length);

  // Count module steps for total
  const moduleSteps = visibleSteps.filter(s => s.type === 'module');

  // Build visible steps array with template indices
  const visibleStepsWithIndices = visibleSteps.map((step, idx) => ({
    step,
    templateIndex: idx,
  }));

  // Load step data for all module steps
  const stepDataMap = new Map<number, import('./indexing/types.js').StepData | null>();
  let moduleIdx = 0;
  for (const vs of visibleStepsWithIndices) {
    if (vs.step.type === 'module') {
      const stepData = await indexManager.getStepData(moduleIdx);
      stepDataMap.set(moduleIdx, stepData);
      moduleIdx++;
    }
  }

  // Generate recovery plan
  const recoveryPlan = await generateRecoveryPlan({
    template,
    moduleSteps,
    visibleSteps: visibleStepsWithIndices,
    resumeInfo,
    stepDataMap,
    cwd,
    cmRoot,
  });

  // Convert recovery plan to TUI state format (single source of truth)
  const recoveryPlanState: RecoveryPlanState | null = recoveryPlan.needsRecovery
    ? {
        needsRecovery: recoveryPlan.needsRecovery,
        startIndex: recoveryPlan.startIndex,
        totalSteps: recoveryPlan.totalSteps,
        completedSteps: recoveryPlan.completedSteps,
        resumableSteps: recoveryPlan.resumableSteps,
        failedSteps: recoveryPlan.failedSteps,
        notStartedSteps: recoveryPlan.notStartedSteps,
        steps: recoveryPlan.steps.map(s => ({
          stepIndex: s.stepIndex,
          templateIndex: s.templateIndex,
          agentId: s.agentId,
          agentName: s.agentName,
          status: s.status,
          sessionId: s.sessionId,
          monitoringId: s.monitoringId,
          agentStatus: s.agentStatus,
          chains: s.chains,
          nextChainIndex: s.nextChainIndex,
          totalChains: s.totalChains,
          error: s.error,
        })),
        summary: recoveryPlan.summary,
        requiresConfirmation: recoveryPlan.requiresConfirmation,
        confirmed: false,
      }
    : null;

  // Emit recovery plan to event bus (for TUI display)
  // This is the single source of truth - CLI, TUI, monitoring DB, step index all use this
  emitter.setRecoveryPlan(recoveryPlanState);

  // Recovery plan confirmation is a hard gate - must confirm before any execution proceeds
  // The startIndex comes ONLY from the confirmed recovery plan, never from raw resumeInfo
  // Recovery execution MUST always come from a confirmed recovery plan - no bypass
  let confirmedStartIndex = 0;
  let confirmedRecoveryPlan: RecoveryPlan | undefined;

  if (recoveryPlan.needsRecovery) {
    if (recoveryPlan.requiresConfirmation) {
      // For TTY environments, display the plan for the user to review in modal
      // For non-TTY, waitForRecoveryConfirmation will handle printing to stderr
      if (process.stdout.isTTY) {
        console.log(formatRecoveryPlan(recoveryPlan));
      }

      // Block until user explicitly confirms
      // - TTY: wait for TUI modal interaction
      // - Non-TTY: fail unless --resume-confirmed is explicitly passed
      const confirmed = await waitForRecoveryConfirmation(options.resumeConfirmed, recoveryPlan);

      if (!confirmed) {
        debug('[Workflow] Recovery cancelled or requires explicit confirmation flag');
        // For non-TTY environments, exit cleanly without creating runner
        // We already printed the recovery plan in waitForRecoveryConfirmation
        if (!process.stdout.isTTY) {
          process.exit(1);
        }
        // For TTY environments, throw error to trigger UI error modal
        emitter.setWorkflowStatus('stopped');
        throw new Error('Workflow recovery cancelled - requires explicit confirmation (--resume-confirmed or interactive confirmation)');
      }

      debug('[Workflow] Recovery confirmed');
      emitter.recoveryConfirmed(true);
    }

    // Start index comes from the confirmed recovery plan (single source of truth)
    confirmedStartIndex = recoveryPlan.startIndex;
    confirmedRecoveryPlan = recoveryPlan;
    debug('[Workflow] Using confirmed recovery plan startIndex=%d', confirmedStartIndex);
  }

  // Initialize index manager with the confirmed start index from recovery plan
  indexManager.setCurrentStepIndex(confirmedStartIndex);

  // Run controller view FIRST if needed (blocks until controller done + user confirms)
  // Timeline population happens AFTER controller view since it's only visible in executing view
  let controllerResult;
  try {
    controllerResult = await runControllerView({
      cwd,
      cmRoot,
      template,
      emitter,
      eventBus,
    });
  } catch (error) {
    debug('[Workflow] Controller view error: %s', (error as Error).message);
    emitter.setWorkflowStatus('error');
    (process as NodeJS.EventEmitter).emit('workflow:error', {
      reason: (error as Error).message,
    });
    throw error;
  }

  // If controller ran, adjust start index to skip the controller agent step
  let actualStartIndex = confirmedStartIndex;
  if (controllerResult.ran && confirmedStartIndex === 0 && moduleSteps.length > 0) {
    const firstStep = moduleSteps[0];
    // Only skip if the first step is the controller agent
    if (firstStep.agentId === controllerResult.agentId) {
      debug('[Workflow] Controller view ran, skipping step 0 (controller agent: %s)', controllerResult.agentId);
      actualStartIndex = 1;
      // Mark step 0 as completed in the index manager
      indexManager.setCurrentStepIndex(1);
      await indexManager.stepCompleted(0);
    }
  }

  // NOW emit workflow started and populate timeline (after controller view is done)
  // This ensures timeline only appears when switching to executing view
  emitter.workflowStarted(template.name, moduleSteps.length);

  // Emit controller info AFTER workflow:started to prevent reset() from clearing it
  // This enables the 'c' key to return to controller even while step agent executes
  if (controllerResult.controllerInfo) {
    const info = controllerResult.controllerInfo;
    emitter.setControllerInfo(info.id, info.name, info.engine, info.model);
  }

  // Pre-populate timeline
  debug('[Workflow] ========== TIMELINE POPULATION ==========');
  debug('[Workflow] confirmedStartIndex=%d, actualStartIndex=%d, total moduleSteps=%d', confirmedStartIndex, actualStartIndex, moduleSteps.length);
  let moduleIndex = 0;
  for (let stepIndex = 0; stepIndex < visibleSteps.length; stepIndex++) {
    const step = visibleSteps[stepIndex];
    if (step.type === 'module') {
      const defaultEngine = registry.getDefault();
      const engineType = step.engine ?? defaultEngine?.metadata.id ?? 'unknown';
      const uniqueAgentId = getUniqueAgentId(step, moduleIndex);
      // Use actualStartIndex to account for controller agent being skipped
      const isCompleted = moduleIndex < actualStartIndex;

      // Resolve model from step or engine default
      const engineModule = registry.get(engineType);
      const resolvedModel = step.model ?? engineModule?.metadata.defaultModel;

      debug('[Workflow] Module %d (step %d): agentId=%s, isCompleted=%s (moduleIndex %d < actualStartIndex %d = %s)',
        moduleIndex, stepIndex, step.agentId, isCompleted, moduleIndex, actualStartIndex, moduleIndex < actualStartIndex);

      emitter.addMainAgent(
        uniqueAgentId,
        step.agentName ?? step.agentId,
        engineType,
        moduleIndex,
        moduleSteps.length,
        stepIndex, // orderIndex: overall step position for timeline ordering
        isCompleted ? 'completed' : 'pending',
        resolvedModel
      );

      // For completed agents, register their monitoringId from template.json
      if (isCompleted) {
        // For controller agent (step 0), use the monitoringId from controller result
        if (moduleIndex === 0 && controllerResult.ran && controllerResult.monitoringId !== undefined) {
          emitter.registerMonitoringId(uniqueAgentId, controllerResult.monitoringId);
          debug('[Workflow] Registered controller monitoringId=%d for step 0 (%s)', controllerResult.monitoringId, uniqueAgentId);
        } else {
          const stepData = await indexManager.getStepData(moduleIndex);
          debug('[Workflow] Module %d marked completed, stepData=%O', moduleIndex, stepData);
          if (stepData?.monitoringId !== undefined) {
            emitter.registerMonitoringId(uniqueAgentId, stepData.monitoringId);
          }
        }
      }

      moduleIndex++;
    } else if (step.type === 'separator') {
      emitter.addSeparator(step.text, stepIndex);
    }
  }
  debug('[Workflow] Timeline populated: %d completed, %d pending',
    actualStartIndex, moduleSteps.length - actualStartIndex);
  debug('[Workflow] ========== END STEP DECISION ==========');

  // Create and run workflow - ONLY use confirmed recovery plan as the single source of truth
  const runner = new WorkflowRunner({
    cwd,
    cmRoot,
    template: { ...template, steps: visibleSteps },
    emitter,
    startIndex: actualStartIndex,
    indexManager,
    status,
    recoveryPlan: confirmedRecoveryPlan,
  });

  try {
    await runner.run();
  } catch (error) {
    debug('[Workflow] Error: %s', (error as Error).message);
    emitter.setWorkflowStatus('error');
    (process as NodeJS.EventEmitter).emit('workflow:error', {
      reason: (error as Error).message,
    });
    throw error;
  } finally {
    // Always cleanup when workflow ends (success, error, or stop)
    runner.signalManager.cleanup();
  }

  // Keep process alive for TUI
  if (eventBus.hasSubscribers()) {
    await new Promise(() => {
      // Never resolves - Ctrl+C exits
    });
  }
}

/**
 * Wait for recovery confirmation.
 *
 * This is a truly blocking decision point - the Promise only resolves when the
 * user explicitly confirms or cancels.
 *
 * For non-interactive environments (CI/CD, non-TTY):
 * - Default behavior: Output the recovery plan and FAIL to prevent accidental resume
 * - Only auto-confirm if explicitly passed `--resume-confirmed` or `--yes` flag
 *
 * @param resumeConfirmed - Explicit confirmation flag from CLI (--yes/--resume-confirmed)
 * @param recoveryPlan - The recovery plan to display in non-TTY environments
 * @returns Promise that resolves to true if confirmed, false if cancelled
 */
async function waitForRecoveryConfirmation(
  resumeConfirmed: boolean | undefined,
  recoveryPlan: RecoveryPlan
): Promise<boolean> {
  // Non-TTY / non-interactive environment
  if (!process.stdout.isTTY) {
    if (resumeConfirmed) {
      // Explicitly confirmed via CLI flag - auto-confirm
      debug('[Recovery] Non-TTY environment, auto-confirming recovery (--resume-confirmed)');
      return true;
    }

    // Default: output plan and fail - no accidental resume in CI
    console.error('\n❌ Workflow recovery requires explicit confirmation in non-interactive environments.');
    console.error(formatRecoveryPlan(recoveryPlan));
    console.error('\nTo proceed with this recovery plan, re-run with --resume-confirmed or --yes flag.');
    return false;
  }

  // TTY / interactive environment - wait for TUI modal confirmation
  return new Promise<boolean>((resolve) => {
    const handleConfirmation = (confirmed: boolean) => {
      debug('[Recovery] Received confirmation from TUI: confirmed=%s', confirmed);
      (process as NodeJS.EventEmitter).off('workflow:recovery-confirmed', handleConfirmation);
      resolve(confirmed);
    };

    (process as NodeJS.EventEmitter).on('workflow:recovery-confirmed', handleConfirmation);
  });
}

export default runWorkflow;
