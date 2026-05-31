/**
 * Step Skip Logic
 *
 * Determines if a workflow step should be skipped at runtime based on:
 * - executeOnce (already completed)
 * - Active loop skip list
 *
 * Note: Track-based and condition-based filtering is handled upstream
 * in run.ts before the runner starts. This module handles runtime skips
 * that depend on dynamic state (completed steps, loop configuration).
 */

import type { WorkflowStep } from '../templates/index.js';
import { isModuleStep } from '../templates/types.js';
import type { WorkflowEventEmitter } from '../events/emitter.js';
import { debug } from '../../shared/logging/logger.js';
import type { ActiveLoop } from '../directives/loop/types.js';
import type { StepIndexManager } from '../indexing/index.js';
import { StatusService } from '../../agents/monitoring/index.js';
import type { RecoveryPlan, StepRecoveryStatus } from '../recovery/types.js';

// Re-export for backwards compatibility
export type { ActiveLoop };

export interface SkipCheckOptions {
  step: WorkflowStep;
  index: number;
  activeLoop: ActiveLoop | null;
  indexManager: StepIndexManager;
  uniqueAgentId?: string;
  emitter?: WorkflowEventEmitter;
  /** Confirmed recovery plan - the single source of truth for resume decisions */
  recoveryPlan?: RecoveryPlan;
}

/**
 * Checks if a step should be skipped at runtime.
 *
 * This function handles dynamic skip conditions that can only be evaluated
 * during workflow execution:
 * - executeOnce: Skip if the step was already completed in a previous run
 * - activeLoop.skip: Skip if the step is in the current loop's skip list
 */
export async function shouldSkipStep(
  options: SkipCheckOptions
): Promise<{ skip: boolean; reason?: string }> {
  const {
    step,
    index,
    activeLoop,
    indexManager,
    uniqueAgentId,
    emitter,
    recoveryPlan,
  } = options;

  // Non-module steps (separators, etc.) can't be skipped
  if (!isModuleStep(step)) {
    return { skip: false };
  }

  // Use provided unique agent ID or fall back to step.agentId
  const agentId = uniqueAgentId ?? step.agentId;

  const status = StatusService.getInstance();

  // Check recovery plan first - this is the single source of truth for resume
  // Skip FAILED steps that the recovery plan says cannot be resumed
  if (recoveryPlan) {
    const recoveryInfo = recoveryPlan.steps.find(s => s.stepIndex === index);
    if (recoveryInfo) {
      // Step is marked as completed in recovery plan - skip it
      if (recoveryInfo.status === StepRecoveryStatus.COMPLETED) {
        debug('[Indexing:Skip] Step %d (%s) skipped - recovery plan says completed', index, step.agentName);
        status.completed(agentId);
        if (emitter) {
          emitter.updateAgentStatus(agentId, 'completed');
        }
        return { skip: true, reason: `${step.agentName} skipped (recovery plan: completed).` };
      }
      // Step is marked as failed in recovery plan - skip and mark as failed
      if (recoveryInfo.status === StepRecoveryStatus.FAILED) {
        debug('[Indexing:Skip] Step %d (%s) skipped - recovery plan says failed: %s', index, step.agentName, recoveryInfo.error);
        status.failed(agentId);
        if (emitter) {
          emitter.updateAgentStatus(agentId, 'failed');
        }
        // Mark step as failed in index manager so it's not re-executed
        await indexManager.stepFailed(index, recoveryInfo.error);
        return { skip: true, reason: `${step.agentName} skipped (recovery plan: failed - ${recoveryInfo.error}).` };
      }
    }
  }

  // Skip step if executeOnce is true and it's already completed
  if (step.executeOnce) {
    const isCompleted = await indexManager.isStepCompleted(index);
    if (isCompleted) {
      debug('[Indexing:Skip] Step %d (%s) skipped - executeOnce already completed', index, step.agentName);
      status.skipped(agentId);
      return { skip: true, reason: `${step.agentName} skipped (already completed).` };
    }
  }

  // Skip step if it's in the active loop's skip list
  if (activeLoop?.skip.includes(step.agentId)) {
    debug('[Indexing:Skip] Step %d (%s) skipped - in active loop skip list', index, step.agentName);
    status.skipped(agentId);
    return { skip: true, reason: `${step.agentName} skipped (loop configuration).` };
  }

  return { skip: false };
}

export function logSkipDebug(step: WorkflowStep, index: number, activeLoop: ActiveLoop | null): void {
  if (!isModuleStep(step)) {
    return;
  }

  if (activeLoop) {
    debug(
      '[Indexing:Skip] Step %d (%s) loop check - skipList=[%s] shouldSkip=%s',
      index,
      step.agentName,
      activeLoop.skip.join(', '),
      activeLoop.skip.includes(step.agentId)
    );
  }
}
