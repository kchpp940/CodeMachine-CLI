/**
 * Mark Failed Signal Handler
 *
 * Handles `workflow:mark-failed` process events (triggered from TUI diagnostic panel).
 * This is the REAL failure flow - NOT a skip.
 *
 * Actions performed:
 * 1. Update monitoring DB with failed status and error
 * 2. Update step index (template.json) with failedAt and error (unrecoverable)
 * 3. Update UI registry via StatusService
 * 4. Send STEP_ERROR event to state machine (proper failure handling)
 * 5. Abort current execution
 */

import { debug } from '../../../shared/logging/logger.js';
import type { SignalContext } from '../manager/types.js';
import { StatusService } from '../../../agents/monitoring/index.js';
import { captureSession } from '../../../agents/session/index.js';

export interface MarkFailedSignalPayload {
  agentId: string;
  monitoringId: number;
}

/**
 * Handle mark failed signal - real failure flow, not a skip
 */
export async function handleMarkFailedSignal(
  ctx: SignalContext,
  payload: MarkFailedSignalPayload,
): Promise<void> {
  const { agentId, monitoringId } = payload;

  debug('[MarkFailedSignal] workflow:mark-failed received, agentId=%s, monitoringId=%d, state=%s',
    agentId, monitoringId, ctx.machine.state);

  const stepContext = ctx.getStepContext();
  if (!stepContext) {
    debug('[MarkFailedSignal] No step context, cannot mark as failed');
    return;
  }

  if (ctx.machine.state === 'running' || ctx.machine.state === 'awaiting' || ctx.machine.state === 'delegated') {
    const status = StatusService.getInstance();
    const errorMsg = 'Marked as failed by user from diagnostic panel';
    const error = new Error(errorMsg);

    // 1. Update monitoring DB with failed status
    try {
      await status.fail(monitoringId, error);
      debug('[MarkFailedSignal] Updated monitoring DB: monitoringId=%d marked as failed', monitoringId);
    } catch (dbErr) {
      debug('[MarkFailedSignal] Warning: Failed to update monitoring DB: %s',
        dbErr instanceof Error ? dbErr.message : String(dbErr));
    }

    // 2. Update UI status (emits to UI registry)
    status.failed(agentId);
    debug('[MarkFailedSignal] Updated UI registry: agentId=%s marked as failed', agentId);

    // 3. Capture session info before aborting
    const session = captureSession(agentId);
    if (session?.sessionId) {
      debug('[MarkFailedSignal] Captured session: monitoringId=%d sessionId=%s',
        session.monitoringId, session.sessionId);
      await ctx.indexManager.stepSessionInitialized(
        stepContext.stepIndex,
        session.sessionId,
        session.monitoringId,
      );
    }

    // 4. Update step index - mark as FAILED (not completed) in template.json
    await ctx.indexManager.stepFailed(stepContext.stepIndex, errorMsg);
    debug('[MarkFailedSignal] Updated step index: step %d marked as failed (unrecoverable)',
      stepContext.stepIndex);

    // 5. Clear queue and UI state
    ctx.indexManager.resetQueue();
    ctx.emitter.setInputState(null);

    // 6. If in delegated state, abort the controller agent first
    if (ctx.machine.state === 'delegated') {
      debug('[MarkFailedSignal] Aborting controller agent');
      ctx.mode.getControllerInput()?.abort?.();
    }

    // 7. Send STEP_ERROR to state machine (real failure handling, NOT skip)
    // This transitions machine to 'error' state - proper failure flow
    ctx.machine.send({ type: 'STEP_ERROR', error });
    debug('[MarkFailedSignal] Sent STEP_ERROR to state machine, transitioning to error state');

    // 8. Abort the step execution
    ctx.getAbortController()?.abort(error);

    debug('[MarkFailedSignal] Mark failed handled - step %d is now permanently failed',
      stepContext.stepIndex);
  }
}
