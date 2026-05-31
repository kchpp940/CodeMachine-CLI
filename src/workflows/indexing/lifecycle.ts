/**
 * Step Lifecycle Management
 *
 * Defines the lifecycle phases of a step and validates transitions.
 */

import type { StepData } from './types.js';
import { StepLifecyclePhase } from './types.js';

/**
 * Determines the current lifecycle phase of a step based on its data
 */
export function getStepPhase(stepData: StepData | null): StepLifecyclePhase {
  if (!stepData) {
    return StepLifecyclePhase.NOT_STARTED;
  }

  // If completedAt is set, step is fully completed
  if (stepData.completedAt) {
    return StepLifecyclePhase.COMPLETED;
  }

  // If failedAt is set, step permanently failed (unrecoverable)
  if (stepData.failedAt) {
    return StepLifecyclePhase.FAILED;
  }

  // If completedChains exists and has entries, step has chained prompts in progress
  if (stepData.completedChains && stepData.completedChains.length > 0) {
    return StepLifecyclePhase.CHAIN_IN_PROGRESS;
  }

  // If sessionId is set, step session has been initialized
  if (stepData.sessionId) {
    return StepLifecyclePhase.SESSION_INITIALIZED;
  }

  // Step data exists but no session - step has started
  return StepLifecyclePhase.STARTED;
}

/**
 * Checks if a step is considered complete (has completedAt set)
 * Note: A failed step is NOT considered complete - use isStepFailed() for that.
 */
export function isStepComplete(stepData: StepData | null): boolean {
  return stepData?.completedAt !== undefined;
}

/**
 * Checks if a step has permanently failed (has failedAt set)
 */
export function isStepFailed(stepData: StepData | null): boolean {
  return stepData?.failedAt !== undefined;
}

/**
 * Checks if a step has reached a terminal state (completed or failed)
 */
export function isStepTerminal(stepData: StepData | null): boolean {
  return isStepComplete(stepData) || isStepFailed(stepData);
}

/**
 * Checks if a step has incomplete chains (started chains but not fully completed)
 * Failed steps are excluded - they are not resumable.
 */
export function hasIncompleteChains(stepData: StepData | null): boolean {
  if (!stepData) return false;
  return (
    stepData.completedChains !== undefined &&
    stepData.completedChains.length > 0 &&
    stepData.completedAt === undefined &&
    stepData.failedAt === undefined
  );
}

/**
 * Gets the next chain index to resume from
 */
export function getNextChainIndex(stepData: StepData | null): number {
  if (!stepData?.completedChains || stepData.completedChains.length === 0) {
    return 0;
  }
  return Math.max(...stepData.completedChains) + 1;
}

/**
 * Checks if a step is resumable (has session data but not completed or failed)
 */
export function isStepResumable(stepData: StepData | null): boolean {
  if (!stepData) return false;
  return !!stepData.sessionId && !stepData.completedAt && !stepData.failedAt;
}
