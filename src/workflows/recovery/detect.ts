/**
 * Crash Recovery Detection
 *
 * Determines if a step should resume from a previous crash.
 * Uses existing lifecycle helpers for consistency.
 *
 * Failed steps (FAILED phase) are never considered for recovery -
 * they are permanently unrecoverable.
 */

import { isStepResumable, isStepFailed } from '../indexing/lifecycle.js';
import type { StepData } from '../indexing/types.js';
import type { CrashDetectionResult } from './types.js';

/**
 * Detect if a step needs crash recovery
 *
 * A step needs recovery if:
 * 1. It has a sessionId (agent conversation was started)
 * 2. It does NOT have completedAt (step didn't finish)
 * 3. It does NOT have failedAt (step didn't permanently fail)
 *
 * @param stepData - Step data from persistence (may be null)
 * @returns Detection result with recovery info
 */
export function detectCrashRecovery(stepData: StepData | null): CrashDetectionResult {
  // Failed steps are never recoverable
  if (isStepFailed(stepData)) {
    return { isRecovering: false };
  }

  // Reuse existing helper from lifecycle.ts
  if (!stepData || !isStepResumable(stepData)) {
    return { isRecovering: false };
  }

  return {
    isRecovering: true,
    sessionId: stepData.sessionId,
    monitoringId: stepData.monitoringId,
    completedChains: stepData.completedChains,
  };
}

/**
 * Check if step data indicates a crash recovery scenario
 * (Simplified version for guards/conditions)
 */
export function isCrashRecovery(stepData: StepData | null): boolean {
  if (isStepFailed(stepData)) return false;
  return isStepResumable(stepData);
}
