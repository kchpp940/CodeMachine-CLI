import { isStepResumable } from '../indexing/lifecycle.js';
import { AgentMonitorService } from '../../agents/monitoring/index.js';
import type { StepData } from '../indexing/types.js';
import type { CrashDetectionResult } from './types.js';
import { debug } from '../../shared/logging/logger.js';

export async function detectCrashRecovery(stepData: StepData | null): Promise<CrashDetectionResult> {
  if (!stepData || !isStepResumable(stepData)) {
    return { isRecovering: false };
  }

  if (stepData.monitoringId !== undefined) {
    const monitor = AgentMonitorService.getInstance();

    if (stepData.monitoringId !== undefined) {
      const reconciled = await monitor.reconcileStaleRunning([stepData.monitoringId]);
      if (reconciled > 0) {
        debug('[recovery/detect] Reconciled stale agent %d for current step', stepData.monitoringId);
      }
    }

    const agent = monitor.getAgent(stepData.monitoringId);

    if (agent) {
      if (agent.status === 'failed') {
        debug('[recovery/detect] Agent %d is failed in DB -> not recoverable', stepData.monitoringId);
        return { isRecovering: false, reason: 'db_failed' };
      }

      if (agent.status === 'completed') {
        debug('[recovery/detect] Agent %d is completed in DB -> not recovering', stepData.monitoringId);
        return { isRecovering: false };
      }
    }
  }

  return {
    isRecovering: true,
    sessionId: stepData.sessionId,
    monitoringId: stepData.monitoringId,
    completedChains: stepData.completedChains,
    reason: 'resumable',
  };
}

export function isCrashRecovery(stepData: StepData | null): boolean {
  return isStepResumable(stepData);
}
