/**
 * Recovery Plan Generator
 *
 * Generates a unified recovery plan for workflow sessions.
 * This is the single source of truth for:
 * - Which steps will be recovered
 * - Which chained prompts are completed
 * - Which agents can be resumed
 * - Which agents can only be marked as failed
 *
 * Used by CLI, TUI, monitoring DB, step index, and recovery logic
 */

import { debug } from '../../shared/logging/logger.js';
import { loadAgentConfig } from '../../agents/runner/index.js';
import { loadChainedPrompts } from '../../agents/runner/chained.js';
import { getSelectedConditions, getSelectedTrack } from '../../shared/workflows/template.js';
import { AgentMonitorService } from '../../agents/monitoring/index.js';
import type { ModuleStep, WorkflowTemplate } from '../templates/types.js';
import type { StepData, ResumeInfo } from '../indexing/types.js';
import { isStepResumable, getNextChainIndex, hasIncompleteChains } from '../indexing/lifecycle.js';
import type {
  RecoveryPlan,
  RecoveryStepInfo,
  RecoveryChainStatus,
  GenerateRecoveryPlanOptions,
} from './types.js';
import { StepRecoveryStatus } from './types.js';

/**
 * Generate a complete recovery plan for a workflow session
 *
 * This function is the single source of truth for all recovery-related information.
 * It combines data from:
 * - Step index manager (template.json)
 * - Monitoring database (agent records)
 * - Agent configuration (chained prompts)
 *
 * @param options - All context needed to generate the plan
 * @returns Complete recovery plan
 */
export async function generateRecoveryPlan(
  options: GenerateRecoveryPlanOptions
): Promise<RecoveryPlan> {
  const {
    template,
    moduleSteps,
    visibleSteps,
    resumeInfo,
    stepDataMap,
    cwd,
    cmRoot,
  } = options;

  debug('[recovery/plan] Generating recovery plan');
  debug('[recovery/plan] Resume info: startIndex=%d, decision=%s',
    resumeInfo.startIndex, resumeInfo.decision);

  const monitor = AgentMonitorService.getInstance();
  const selectedConditions = await getSelectedConditions(cmRoot);
  const selectedTrack = await getSelectedTrack(cmRoot);

  const steps: RecoveryStepInfo[] = [];
  let completedSteps = 0;
  let resumableSteps = 0;
  let failedSteps = 0;
  let notStartedSteps = 0;

  // Build template index to module index mapping
  const templateToModuleIndex = new Map<number, number>();
  let moduleIdx = 0;
  for (const vs of visibleSteps) {
    if ('type' in vs.step && vs.step.type === 'module') {
      templateToModuleIndex.set(vs.templateIndex, moduleIdx);
      moduleIdx++;
    }
  }

  // Process each module step
  for (let i = 0; i < moduleSteps.length; i++) {
    const step = moduleSteps[i];
    const stepData = stepDataMap.get(i) ?? null;
    const templateIndexEntry = [...templateToModuleIndex.entries()].find(([_, mi]) => mi === i);
    const templateIndex = templateIndexEntry ? templateIndexEntry[0] : i;

    const stepInfo = await buildStepRecoveryInfo(
      step,
      i,
      templateIndex,
      stepData,
      monitor,
      cwd,
      selectedConditions,
      selectedTrack
    );

    steps.push(stepInfo);

    switch (stepInfo.status) {
      case StepRecoveryStatus.COMPLETED:
        completedSteps++;
        break;
      case StepRecoveryStatus.RESUMABLE:
      case StepRecoveryStatus.FAILED:
        resumableSteps++;
        break;
      case StepRecoveryStatus.NOT_STARTED:
        notStartedSteps++;
        break;
    }
  }

  const needsRecovery = resumeInfo.startIndex > 0 ||
    steps.some(s => s.status === StepRecoveryStatus.RESUMABLE);

  const summary = buildSummary(
      needsRecovery,
      steps.length,
      completedSteps,
      resumableSteps,
      notStartedSteps,
      resumeInfo
    );

  const requiresConfirmation = needsRecovery &&
    (resumableSteps > 0 || failedSteps > 0);

  debug('[recovery/plan] Recovery plan generated:');
  debug('[recovery/plan]   - needsRecovery: %s', needsRecovery);
  debug('[recovery/plan]   - totalSteps: %d', steps.length);
  debug('[recovery/plan]   - completedSteps: %d', completedSteps);
  debug('[recovery/plan]   - resumableSteps: %d', resumableSteps);
  debug('[recovery/plan]   - notStartedSteps: %d', notStartedSteps);
  debug('[recovery/plan]   - requiresConfirmation: %s', requiresConfirmation);

  return {
    needsRecovery,
    resumeDecision: resumeInfo.decision,
    startIndex: resumeInfo.startIndex,
    totalSteps: steps.length,
    completedSteps,
    resumableSteps,
    failedSteps,
    notStartedSteps,
    steps,
    summary,
    requiresConfirmation,
  };
}

/**
 * Build recovery information for a single step
 */
async function buildStepRecoveryInfo(
  step: ModuleStep,
  stepIndex: number,
  templateIndex: number,
  stepData: StepData | null,
  monitor: AgentMonitorService,
  cwd: string,
  selectedConditions: string[],
  selectedTrack: string | null
): Promise<RecoveryStepInfo> {
  const baseInfo: RecoveryStepInfo = {
    stepIndex,
    templateIndex,
    agentId: step.agentId,
    agentName: step.agentName ?? step.agentId,
    status: StepRecoveryStatus.NOT_STARTED,
  };

  // Check if step is completed
  if (stepData?.completedAt) {
    baseInfo.status = StepRecoveryStatus.COMPLETED;
    baseInfo.sessionId = stepData.sessionId;
    baseInfo.monitoringId = stepData.monitoringId;
    return baseInfo;
  }

  // Check if step has session data but not completed
  if (stepData && isStepResumable(stepData)) {
    baseInfo.sessionId = stepData.sessionId;
    baseInfo.monitoringId = stepData.monitoringId;

    // Get agent status from monitoring DB
    if (stepData.monitoringId !== undefined) {
      const agentRecord = monitor.getAgent(stepData.monitoringId);
      if (agentRecord) {
        baseInfo.agentStatus = agentRecord.status;

        // Check if session is still valid
        if (agentRecord.status === 'failed' || agentRecord.status === 'skipped') {
          baseInfo.status = StepRecoveryStatus.FAILED;
          baseInfo.error = agentRecord.error;
        } else {
          baseInfo.status = StepRecoveryStatus.RESUMABLE;
        }
      } else {
        // Agent record not found - might still be resumable if sessionId exists
        baseInfo.status = StepRecoveryStatus.RESUMABLE;
      }
    } else {
      // No monitoring ID but has session ID
      baseInfo.status = StepRecoveryStatus.RESUMABLE;
    }

    // Load chained prompts status
    if (step.agentId) {
      const agentConfig = await loadAgentConfig(step.agentId, cwd);
      if (agentConfig?.chainedPromptsPath) {
        const chainedPrompts = await loadChainedPrompts(
          agentConfig.chainedPromptsPath,
          cwd,
          selectedConditions,
          selectedTrack
        );

        if (chainedPrompts.length > 0) {
          const nextChainIndex = getNextChainIndex(stepData);
          baseInfo.chains = buildChainStatus(
            chainedPrompts,
            stepData.completedChains ?? [],
            nextChainIndex
          );
          baseInfo.nextChainIndex = nextChainIndex;
          baseInfo.totalChains = chainedPrompts.length;
        }
      }
    }

    return baseInfo;
  }

  // Step started but no session yet
  if (stepData && !stepData.sessionId) {
    baseInfo.status = StepRecoveryStatus.FAILED;
    baseInfo.error = 'Step started but no session data available';
    return baseInfo;
  }

  return baseInfo;
}

/**
 * Build chain status array for chained prompts
 */
function buildChainStatus(
  chainedPrompts: Array<{ name: string; label: string; content: string }>,
  completedChains: number[],
  nextChainIndex: number
): RecoveryChainStatus[] {
  return chainedPrompts.map((prompt, index) => ({
    index,
    name: prompt.name,
    label: prompt.label,
    completed: completedChains.includes(index),
    isNext: index === nextChainIndex,
  }));
}

/**
 * Build a human-readable summary message
 */
function buildSummary(
  needsRecovery: boolean,
  totalSteps: number,
  completedSteps: number,
  resumableSteps: number,
  notStartedSteps: number,
  resumeInfo: ResumeInfo
): string {
  if (!needsRecovery) {
    return `Starting fresh workflow with ${totalSteps} steps`;
  }

  const parts: string[] = [];

  if (completedSteps > 0) {
    parts.push(`${completedSteps} completed`);
  }

  if (resumableSteps > 0) {
    parts.push(`${resumableSteps} to resume`);
  }

  if (notStartedSteps > 0) {
    parts.push(`${notStartedSteps} pending`);
  }

  return `Resuming workflow: ${parts.join(', ')}`;
}

/**
 * Format recovery plan for CLI display
 */
export function formatRecoveryPlan(plan: RecoveryPlan): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('╔══════════════════════════════════════════════════════════════╗');
  lines.push('║              WORKFLOW RECOVERY PLAN                          ║');
  lines.push('╚══════════════════════════════════════════════════════════════╝');
  lines.push('');

  lines.push(`Summary: ${plan.summary}`);
  lines.push('');

  // Status legend
  lines.push('Step Status Legend:');
  lines.push('  ✓ Completed    - Step fully completed');
  lines.push('  ⟳ Resume   - Can be resumed from crash/pause');
  lines.push('  ✗ Failed   - Started but cannot be resumed');
  lines.push('  ○ Pending  - Not started yet');
  lines.push('');

  // Step details
  lines.push('───────────────────────────────────────────────────────────────');
  lines.push('');

  for (const step of plan.steps) {
    const statusIcon = getStatusIcon(step.status);
    const statusLabel = getStatusLabel(step.status);

    lines.push(`${statusIcon} Step ${step.stepIndex + 1}: ${step.agentName}`);
    lines.push(`   Status: ${statusLabel}`);

    if (step.status === StepRecoveryStatus.RESUMABLE && step.chains) {
      lines.push(`   Chained prompts: ${step.chains.filter(c => c.completed).length}/${step.totalChains} completed`);
      
      const nextChain = step.chains.find(c => c.isNext);
      if (nextChain) {
        lines.push(`   Next: ${nextChain.label}`);
      }
    }

    if (step.status === StepRecoveryStatus.FAILED && step.error) {
      lines.push(`   Error: ${step.error}`);
    }

    lines.push('');
  }

  lines.push('───────────────────────────────────────────────────────────────');
  lines.push('');

  return lines.join('\n');
}

function getStatusIcon(status: StepRecoveryStatus): string {
  switch (status) {
    case StepRecoveryStatus.COMPLETED:
      return '✓';
    case StepRecoveryStatus.RESUMABLE:
      return '⟳';
    case StepRecoveryStatus.FAILED:
      return '✗';
    case StepRecoveryStatus.NOT_STARTED:
      return '○';
    default:
      return '?';
  }
}

function getStatusLabel(status: StepRecoveryStatus): string {
  switch (status) {
    case StepRecoveryStatus.COMPLETED:
      return 'Completed';
    case StepRecoveryStatus.RESUMABLE:
      return 'Resumable';
    case StepRecoveryStatus.FAILED:
      return 'Failed';
    case StepRecoveryStatus.NOT_STARTED:
      return 'Not Started';
    default:
      return 'Unknown';
  }
}
