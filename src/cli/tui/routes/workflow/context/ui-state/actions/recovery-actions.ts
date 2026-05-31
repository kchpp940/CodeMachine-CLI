/**
 * Recovery Plan Actions
 *
 * Actions for managing recovery plan state in the UI.
 */

import type { WorkflowState, RecoveryPlanState } from "../types"
import { debug } from "../../../../../../../shared/logging/logger.js"

export type RecoveryActionsContext = {
  getState(): WorkflowState
  setState(state: WorkflowState): void
  notify(): void
}

export function createRecoveryActions(ctx: RecoveryActionsContext) {
  /**
   * Set the recovery plan state
   */
  function setRecoveryPlan(recoveryPlan: RecoveryPlanState | null): void {
    const state = ctx.getState()
    debug('[UI-RECOVERY] setRecoveryPlan: needsRecovery=%s, requiresConfirmation=%s',
      recoveryPlan?.needsRecovery ?? 'null',
      recoveryPlan?.requiresConfirmation ?? 'null')
    ctx.setState({ ...state, recoveryPlan })
    ctx.notify()
  }

  /**
   * Mark recovery plan as confirmed or cancelled
   */
  function confirmRecovery(confirmed: boolean): void {
    const state = ctx.getState()
    if (!state.recoveryPlan) {
      debug('[UI-RECOVERY] confirmRecovery called but no recovery plan exists')
      return
    }

    debug('[UI-RECOVERY] confirmRecovery: confirmed=%s', confirmed)
    ctx.setState({
      ...state,
      recoveryPlan: {
        ...state.recoveryPlan,
        confirmed,
      },
    })
    ctx.notify()
  }

  return {
    setRecoveryPlan,
    confirmRecovery,
  }
}
