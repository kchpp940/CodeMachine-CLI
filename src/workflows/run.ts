/**
 * Workflow Runner Entry Point
 *
 * Pure execution phase — accepts a pre-resolved ExecutionContext from
 * the WorkflowExecutionGateway, which handles all preview, onboarding,
 * confirm, and setup phases.
 *
 * Do NOT call this directly; go through the gateway.
 */

import type { WorkflowStep, WorkflowTemplate } from './templates/types.js';
import { debug } from '../shared/logging/logger.js';
import {
  getControllerView,
  loadControllerConfig,
  saveControllerConfig,
} from '../shared/workflows/index.js';
import { StepIndexManager } from './indexing/index.js';
import { registry } from '../infra/engines/index.js';
import { MonitoringCleanup, AgentMonitorService, StatusService } from '../agents/monitoring/index.js';
import { WorkflowEventEmitter } from './events/index.js';
import { ensureWorkspaceStructure, mirrorSubAgents } from '../runtime/services/workspace/index.js';
import { WorkflowRunner } from './runner/index.js';
import { getUniqueAgentId } from './context/index.js';
import { runControllerView } from './controller/view.js';
import { getAllInstalledImports } from '../shared/imports/index.js';
import { registerImportedAgents, clearImportedAgents } from './utils/config.js';
import type { ExecutionContext } from './gateway/types.js';

export { ValidationError, checkWorkflowCanStart, checkSpecificationRequired, checkOnboardingRequired, needsOnboarding } from './preflight.js';
export type { WorkflowStep, WorkflowTemplate, ExecutionContext };

export async function runWorkflow(context: ExecutionContext): Promise<void> {
  const {
    cwd,
    cmRoot,
    template,
    templatePath,
    selectedTrack,
    selectedConditions,
    eventBus,
  } = context;

  await ensureWorkspaceStructure({ cwd });

  clearImportedAgents();
  const importedPackages = getAllInstalledImports();
  for (const imp of importedPackages) {
    registerImportedAgents(imp.resolvedPaths.config);
  }
  debug('[Workflow] Registered agents from %d imported packages', importedPackages.length);

  if (process.stdout.isTTY) {
    process.stdout.write('\x1b[2J\x1b[H');
  }

  MonitoringCleanup.setup();

  const indexManager = new StepIndexManager(cmRoot);

  MonitoringCleanup.registerWorkflowHandlers({
    onBeforeCleanup: async () => {
      const isInControllerView = await getControllerView(cmRoot);
      const monitor = AgentMonitorService.getInstance();
      const activeAgents = monitor.getActiveAgents();
      const rootAgents = activeAgents.filter((agent) => !agent.parentId);

      for (const agent of rootAgents) {
        if (agent.sessionId) {
          if (isInControllerView) {
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
            const stepIndex = indexManager.currentStepIndex;
            debug('[Workflow] Saving session state on Ctrl+C: step=%d, sessionId=%s, monitoringId=%d',
              stepIndex, agent.sessionId, agent.id);
            await indexManager.stepSessionInitialized(stepIndex, agent.sessionId, agent.id);
          }
        }
      }
    },
  });

  debug('[Workflow] Using template: %s (path=%s)', template.name, templatePath);

  if (template.subAgentIds && template.subAgentIds.length > 0) {
    debug('[Workflow] Mirroring %d sub-agents', template.subAgentIds.length);
    await mirrorSubAgents({ cwd, subAgentIds: template.subAgentIds });
  }

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

  const emitter = new WorkflowEventEmitter(eventBus);

  const status = StatusService.getInstance();
  status.setEmitter(emitter);

  const resumeInfo = await indexManager.getResumeInfo();
  const startIndex = resumeInfo.startIndex;
  debug('[Workflow] ========== STEP DECISION ==========');
  debug('[Workflow] Resume info: startIndex=%d, decision=%s', startIndex, resumeInfo.decision);
  debug('[Workflow] selectedTrack: %s', selectedTrack);
  debug('[Workflow] selectedConditions: %O', selectedConditions);

  debug('[Workflow] Filtering %d template steps...', template.steps.length);
  const visibleSteps = template.steps.filter((step, idx) => {
    if (step.type === 'separator') {
      debug('[Workflow] Step %d: type=separator → included (visual separator)', idx);
      return true;
    }
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

  const moduleSteps = visibleSteps.filter(s => s.type === 'module');

  indexManager.setCurrentStepIndex(startIndex);

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

  let actualStartIndex = startIndex;
  if (controllerResult.ran && startIndex === 0 && moduleSteps.length > 0) {
    const firstStep = moduleSteps[0];
    if (firstStep.agentId === controllerResult.agentId) {
      debug('[Workflow] Controller view ran, skipping step 0 (controller agent: %s)', controllerResult.agentId);
      actualStartIndex = 1;
      indexManager.setCurrentStepIndex(1);
      await indexManager.stepCompleted(0);
    }
  }

  emitter.workflowStarted(template.name, moduleSteps.length);

  if (controllerResult.controllerInfo) {
    const info = controllerResult.controllerInfo;
    emitter.setControllerInfo(info.id, info.name, info.engine, info.model);
  }

  debug('[Workflow] ========== TIMELINE POPULATION ==========');
  debug('[Workflow] startIndex=%d, actualStartIndex=%d, total moduleSteps=%d', startIndex, actualStartIndex, moduleSteps.length);
  let moduleIndex = 0;
  for (let stepIndex = 0; stepIndex < visibleSteps.length; stepIndex++) {
    const step = visibleSteps[stepIndex];
    if (step.type === 'module') {
      const defaultEngine = registry.getDefault();
      const engineType = step.engine ?? defaultEngine?.metadata.id ?? 'unknown';
      const uniqueAgentId = getUniqueAgentId(step, moduleIndex);
      const isCompleted = moduleIndex < actualStartIndex;

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
        stepIndex,
        isCompleted ? 'completed' : 'pending',
        resolvedModel
      );

      if (isCompleted) {
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

  const runner = new WorkflowRunner({
    cwd,
    cmRoot,
    template: { ...template, steps: visibleSteps },
    emitter,
    startIndex: actualStartIndex,
    indexManager,
    status,
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
    runner.signalManager.cleanup();
  }

  if (eventBus.hasSubscribers()) {
    await new Promise(() => {
    });
  }
}

export default runWorkflow;
