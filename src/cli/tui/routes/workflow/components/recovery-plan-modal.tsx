/** @jsxImportSource @opentui/solid */
/**
 * Recovery Plan Confirmation Modal
 *
 * Displays the recovery plan to the user before resuming a workflow.
 * Shows which steps will be resumed, which are completed, and which have failed.
 */

import { For, Show, createMemo, createSignal } from "solid-js"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "@tui/shared/context/theme"
import { ModalBase } from "@tui/shared/components/modal/modal-base"
import { ModalContent } from "@tui/shared/components/modal/modal-content"
import { ModalHeader } from "@tui/shared/components/modal/modal-header"
import { ModalFooter } from "@tui/shared/components/modal/modal-footer"
import type { RecoveryPlanState, RecoveryStepInfo, StepRecoveryStatus } from "@tui/routes/workflow/state/types"

export interface RecoveryPlanModalProps {
  recoveryPlan: RecoveryPlanState
  onConfirm: () => void
  onCancel: () => void
  width?: number
}

type ButtonType = "confirm" | "cancel"

export function RecoveryPlanModal(props: RecoveryPlanModalProps) {
  const themeCtx = useTheme()
  const dimensions = useTerminalDimensions()
  const [selectedButton, setSelectedButton] = createSignal<ButtonType>("confirm")

  const modalWidth = () => {
    const safeWidth = Math.max(50, (dimensions()?.width ?? 80) - 8)
    return Math.min(props.width ?? safeWidth, 80)
  }

  useKeyboard((evt) => {
    if (evt.name === "left" || evt.name === "right" || evt.name === "tab") {
      evt.preventDefault()
      setSelectedButton((prev) => (prev === "confirm" ? "cancel" : "confirm"))
      return
    }

    if (evt.name === "return") {
      evt.preventDefault()
      if (selectedButton() === "confirm") {
        props.onConfirm()
      } else {
        props.onCancel()
      }
      return
    }

    if (evt.name === "y" || evt.name === "r") {
      evt.preventDefault()
      props.onConfirm()
      return
    }

    if (evt.name === "n" || evt.name === "escape" || evt.name === "c") {
      evt.preventDefault()
      props.onCancel()
      return
    }
  })

  const getStatusIcon = (status: StepRecoveryStatus): string => {
    switch (status) {
      case "completed":
        return "✓"
      case "resumable":
        return "⟳"
      case "failed":
        return "✗"
      case "not_started":
        return "○"
      case "excluded":
        return "⊘"
      default:
        return "?"
    }
  }

  const getStatusColor = (status: StepRecoveryStatus) => {
    switch (status) {
      case "completed":
        return themeCtx.theme.success
      case "resumable":
        return themeCtx.theme.info
      case "failed":
        return themeCtx.theme.error
      case "not_started":
        return themeCtx.theme.textMuted
      case "excluded":
        return themeCtx.theme.textMuted
      default:
        return themeCtx.theme.textMuted
    }
  }

  const getStatusLabel = (status: StepRecoveryStatus): string => {
    switch (status) {
      case "completed":
        return "Completed"
      case "resumable":
        return "Resumable"
      case "failed":
        return "Failed"
      case "not_started":
        return "Pending"
      case "excluded":
        return "Excluded"
      default:
        return "Unknown"
    }
  }

  const getChainProgress = (step: RecoveryStepInfo): string | null => {
    if (!step.chains || step.status !== "resumable") return null
    const completed = step.chains.filter((c: { completed: boolean }) => c.completed).length
    const total = step.totalChains ?? 0
    return `${completed}/${total} chains completed`
  }

  const getNextChain = (step: RecoveryStepInfo): string | null => {
    if (!step.chains || step.status !== "resumable") return null
    const next = step.chains.find((c: { isNext: boolean }) => c.isNext)
    return next ? next.label : null
  }

  // Sort steps: completed first, then resumable, then failed, then not started
  const sortedSteps = createMemo(() => {
    const order: Record<StepRecoveryStatus, number> = {
      "completed": 0,
      "resumable": 1,
      "failed": 2,
      "not_started": 3,
      "excluded": 4,
    }
    return [...props.recoveryPlan.steps].sort((a, b) => order[a.status] - order[b.status])
  })

  return (
    <ModalBase width={modalWidth()} onClose={props.onCancel}>
      <ModalHeader title="Recovery Plan Preview" />

      <ModalContent paddingTop={1}>
        {/* Summary */}
        <box paddingBottom={1} flexDirection="column">
          <text fg={themeCtx.theme.text} attributes={1}>
            {props.recoveryPlan.summary}
          </text>
          <text fg={themeCtx.theme.textMuted}>
            Start from step {props.recoveryPlan.startIndex + 1} of {props.recoveryPlan.totalSteps}
          </text>
        </box>

        {/* Legend */}
        <box paddingBottom={1} flexDirection="column">
          <text fg={themeCtx.theme.text} attributes={1}>
            Status Legend:
          </text>
          <text fg={themeCtx.theme.success}>  ✓ Completed    - Step fully completed</text>
          <text fg={themeCtx.theme.info}>  ⟳ Resumable   - Can be resumed from crash/pause</text>
          <text fg={themeCtx.theme.error}>  ✗ Failed      - Started but cannot be resumed</text>
          <text fg={themeCtx.theme.textMuted}>  ○ Pending     - Not started yet</text>
        </box>

        {/* Step list */}
        <box paddingTop={1} flexDirection="column" maxHeight={Math.max(10, (dimensions()?.height ?? 30) - 20)}>
          <text fg={themeCtx.theme.text} attributes={1}>
            Steps:
          </text>
          <scrollbox height="100%" scrollbarOptions={{ visible: false }}>
            <For each={sortedSteps()}>
              {(step) => (
                <box paddingLeft={1} paddingTop={1} flexDirection="column">
                  {/* Step main line */}
                  <box flexDirection="row">
                    <text fg={getStatusColor(step.status)}>
                      {getStatusIcon(step.status)}
                    </text>
                    <text fg={themeCtx.theme.text}>
                      {" "}Step {step.stepIndex + 1}: {step.agentName}
                    </text>
                    <text fg={getStatusColor(step.status)}>
                      {" "}[{getStatusLabel(step.status)}]
                    </text>
                  </box>

                  {/* Chain progress */}
                  <Show when={getChainProgress(step)}>
                    <box paddingLeft={2}>
                      <text fg={themeCtx.theme.info}>
                        ⎿ {getChainProgress(step)}
                      </text>
                    </box>
                  </Show>

                  {/* Next chain */}
                  <Show when={getNextChain(step)}>
                    <box paddingLeft={2}>
                      <text fg={themeCtx.theme.textMuted}>
                        ⎿ Next: {getNextChain(step)}
                      </text>
                    </box>
                  </Show>

                  {/* Error message */}
                  <Show when={step.error}>
                    <box paddingLeft={2}>
                      <text fg={themeCtx.theme.error}>
                        ⎿ Error: {step.error}
                      </text>
                    </box>
                  </Show>
                </box>
              )}
            </For>
          </scrollbox>
        </box>
      </ModalContent>

      {/* Action buttons */}
      <box flexDirection="row" justifyContent="center" gap={2} paddingTop={1} paddingBottom={1}>
        <box
          paddingLeft={3}
          paddingRight={3}
          backgroundColor={selectedButton() === "confirm" ? themeCtx.theme.primary : themeCtx.theme.backgroundElement}
          borderColor={selectedButton() === "confirm" ? themeCtx.theme.primary : themeCtx.theme.borderSubtle}
          border
        >
          <text fg={selectedButton() === "confirm" ? themeCtx.theme.background : themeCtx.theme.text}>
            Resume Workflow
          </text>
        </box>
        <box
          paddingLeft={3}
          paddingRight={3}
          backgroundColor={selectedButton() === "cancel" ? themeCtx.theme.error : themeCtx.theme.backgroundElement}
          borderColor={selectedButton() === "cancel" ? themeCtx.theme.error : themeCtx.theme.borderSubtle}
          border
        >
          <text fg={selectedButton() === "cancel" ? themeCtx.theme.background : themeCtx.theme.text}>
            Cancel
          </text>
        </box>
      </box>

      <ModalFooter shortcuts="[Left/Right] Navigate  [ENTER] Confirm  [R] Resume  [N/Esc] Cancel" />
    </ModalBase>
  )
}
