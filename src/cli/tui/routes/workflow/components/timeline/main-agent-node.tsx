/** @jsxImportSource @opentui/solid */
/**
 * Main Agent Node Component
 * Ported from: src/ui/components/MainAgentNode.tsx
 *
 * Display a single main agent with status, telemetry, and duration
 */

import { Show, createMemo } from "solid-js"
import { useTheme } from "@tui/shared/context/theme"
import { useTimer, formatDuration } from "@tui/shared/services"
import { Spinner } from "@tui/shared/components/spinner"
import type { AgentState, StepRecoveryStatus, RecoveryStepInfo } from "../../state/types"
import { truncate } from "../../state/formatters"
import { getStatusIcon, getStatusColor } from "./status-utils"

export interface MainAgentNodeProps {
  agent: AgentState
  isSelected: boolean
  availableWidth?: number
  recoveryInfo?: RecoveryStepInfo | null
}

// Maximum agent name length before truncation
const MAX_NAME_LENGTH = 22
// Minimum timeline section width to show engine name
const MIN_WIDTH_FOR_ENGINE = 45

export function MainAgentNode(props: MainAgentNodeProps) {
  const themeCtx = useTheme()
  const timer = useTimer()

  // Only show engine if timeline section is wide enough
  const showEngine = () => (props.availableWidth ?? 80) >= MIN_WIDTH_FOR_ENGINE

  const color = () => {
    if (props.recoveryInfo && props.recoveryInfo.status !== 'not_started' && props.agent.status === 'pending') {
      return getRecoveryColor(props.recoveryInfo.status, themeCtx.theme)
    }
    return props.agent.error ? themeCtx.theme.error : getStatusColor(props.agent.status, themeCtx.theme)
  }

  // Recovery status icon and label
  const recoveryIcon = createMemo(() => {
    if (!props.recoveryInfo) return null
    if (props.agent.status !== 'pending') return null
    return getRecoveryIcon(props.recoveryInfo.status)
  })

  const recoveryLabel = createMemo(() => {
    if (!props.recoveryInfo) return null
    if (props.agent.status !== 'pending') return null
    return getRecoveryLabel(props.recoveryInfo.status)
  })

  // Show chain progress if resumable
  const chainProgress = createMemo(() => {
    if (!props.recoveryInfo || !props.recoveryInfo.chains) return null
    if (props.recoveryInfo.status !== 'resumable') return null
    const completed = props.recoveryInfo.chains.filter(c => c.completed).length
    const total = props.recoveryInfo.totalChains ?? 0
    return `${completed}/${total} chains completed`
  })

  // Duration: running/awaiting = live timer, completed = stored duration, queued = 00:00
  const duration = () => {
    const { duration: storedDuration, status } = props.agent

    // Completed - use stored duration
    if (storedDuration !== undefined) {
      return formatDuration(storedDuration)
    }

    // Running, delegated, or awaiting - live timer (shows frozen time when paused)
    if (status === "running" || status === "delegated" || status === "awaiting") {
      return timer.agentDuration(props.agent.id)
    }

    // Queued/pending - don't show duration
    return ""
  }

  const hasLoopRound = () => props.agent.loopRound && props.agent.loopRound > 0

  // Selection indicator
  const selectionPrefix = () => (props.isSelected ? "> " : "  ")

  const displayName = () => truncate(props.agent.name, MAX_NAME_LENGTH)

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      {/* Main line - use wrapMode="none" and overflow="hidden" to prevent text wrapping */}
      <box flexDirection="row" overflow="hidden">
        <text wrapMode="none" fg={themeCtx.theme.text}>{selectionPrefix()}</text>
        <Show when={recoveryIcon()} fallback={
          <Show when={props.agent.status === "running" || props.agent.status === "delegated"} fallback={
            <text wrapMode="none" fg={color()}>{getStatusIcon(props.agent.status)} </text>
          }>
            <Show when={timer.isPaused()} fallback={
              <>
                <Spinner color={color()} />
                <text wrapMode="none"> </text>
              </>
            }>
              <text wrapMode="none" fg={themeCtx.theme.warning}>|| </text>
            </Show>
          </Show>
        }>
          <text wrapMode="none" fg={color()}>{recoveryIcon()} </text>
        </Show>
        <text wrapMode="none" fg={themeCtx.theme.text} attributes={1}>{displayName()}</text>
        <Show when={recoveryLabel()}>
          <text wrapMode="none" fg={color()}> [{recoveryLabel()}]</text>
        </Show>
        <Show when={showEngine()}>
          <text wrapMode="none" fg={themeCtx.theme.textMuted}> ({props.agent.engine})</text>
        </Show>
        <Show when={duration()}>
          <text wrapMode="none" fg={themeCtx.theme.textMuted}> • {duration()}</text>
        </Show>
      </box>

      {/* Chain progress line (if resumable) */}
      <Show when={chainProgress()}>
        <box paddingLeft={2}>
          <text fg={themeCtx.theme.info}>
            ⎿ {chainProgress()}
          </text>
        </box>
      </Show>

      {/* Loop cycle line (if in loop) */}
      <Show when={hasLoopRound()}>
        <box paddingLeft={2}>
          <text fg={themeCtx.theme.info} attributes={1}>
            ⎿ Cycle {props.agent.loopRound}
            {props.agent.loopReason ? ` - ${props.agent.loopReason}` : ""}
          </text>
        </box>
      </Show>
    </box>
  )
}

function getRecoveryIcon(status: StepRecoveryStatus): string {
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

function getRecoveryLabel(status: StepRecoveryStatus): string {
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

function getRecoveryColor(status: StepRecoveryStatus, theme: { success: any; warning: any; error: any; textMuted: any; info: any }) {
  switch (status) {
    case "completed":
      return theme.success
    case "resumable":
      return theme.info
    case "failed":
      return theme.error
    case "not_started":
      return theme.textMuted
    case "excluded":
      return theme.textMuted
    default:
      return theme.textMuted
  }
}
