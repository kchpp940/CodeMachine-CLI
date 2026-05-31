/** @jsxImportSource @opentui/solid */
/**
 * Diagnostic Panel Component
 *
 * Shows diagnostic information for steps stuck in non-terminal states
 * (running, paused, awaiting, failed). Displays monitoringId, sessionId,
 * log file path, index status, resumable reason, and provides actions
 * to continue, mark failed, or open logs.
 */

import { For, Show, createMemo } from "solid-js"
import { useTheme } from "@tui/shared/context/theme"
import { AgentMonitorService } from "../../../../../../agents/monitoring/index.js"
import type { AgentState, SubAgentState, AgentStatus } from "../../state/types"
import { getStatusIcon, getStatusColor } from "./status-utils"
import { truncate } from "../../state/formatters"

type StuckAgent = AgentState | SubAgentState

const STUCK_STATUSES: Set<AgentStatus> = new Set(["running", "paused", "awaiting", "failed"])

interface DiagnosticEntry {
  agent: StuckAgent
  monitoringId: number | undefined
  sessionId: string | undefined
  logPath: string | undefined
  failedReason: string | undefined
  isResumable: boolean
  resumableReason: string
}

export interface DiagnosticPanelProps {
  agents: AgentState[]
  subAgents: Map<string, SubAgentState[]>
  availableWidth?: number
  onContinue: (agentId: string) => void
  onMarkFailed: (agentId: string) => void
  onOpenLog: (agentId: string) => void
}

function buildDiagnosticEntries(
  agents: AgentState[],
  subAgents: Map<string, SubAgentState[]>,
): DiagnosticEntry[] {
  const monitor = AgentMonitorService.getInstance()
  const entries: DiagnosticEntry[] = []

  const processAgent = (agent: StuckAgent) => {
    if (!STUCK_STATUSES.has(agent.status)) return

    const mid = agent.monitoringId
    const record = mid !== undefined ? monitor.getAgent(mid) : undefined

    let isResumable = false
    let resumableReason = ""
    let failedReason: string | undefined

    if (agent.status === "failed") {
      isResumable = false
      failedReason = agent.error || record?.error || undefined
      resumableReason = failedReason
        ? `Permanently failed: ${failedReason}`
        : "Permanently failed — unrecoverable"
    } else if (agent.status === "paused") {
      isResumable = !!record?.sessionId
      resumableReason = record?.sessionId
        ? "Has active session — can be resumed"
        : "No session — cannot resume automatically"
    } else if (agent.status === "awaiting") {
      isResumable = !!record?.sessionId
      resumableReason = record?.sessionId
        ? "Waiting for input — can continue with session"
        : "Waiting for input but no session — cannot resume"
    } else if (agent.status === "running") {
      isResumable = false
      resumableReason = "Step is currently running — cannot resume"
    }

    entries.push({
      agent,
      monitoringId: mid,
      sessionId: record?.sessionId,
      logPath: record?.logPath,
      failedReason,
      isResumable,
      resumableReason,
    })
  }

  for (const agent of agents) {
    processAgent(agent)
  }

  for (const subs of subAgents.values()) {
    for (const sub of subs) {
      processAgent(sub)
    }
  }

  return entries
}

export function DiagnosticPanel(props: DiagnosticPanelProps) {
  const themeCtx = useTheme()

  const entries = createMemo(() =>
    buildDiagnosticEntries(props.agents, props.subAgents),
  )

  const labelWidth = 14
  const nameMaxLen = 20

  const separator = () => "─".repeat(Math.max(30, (props.availableWidth ?? 60) - 2))

  return (
    <box flexDirection="column" paddingTop={0} paddingBottom={0}>
      <box paddingLeft={1} paddingRight={1}>
        <text fg={themeCtx.theme.warning} attributes={1}>
          ⚑ Diagnostic Panel
        </text>
      </box>

      <Show
        when={entries().length > 0}
        fallback={
          <box paddingLeft={1}>
            <text fg={themeCtx.theme.textMuted}>No stuck steps detected.</text>
          </box>
        }
      >
        <For each={entries()}>
          {(entry, idx) => {
            const color = () =>
              entry.agent.error
                ? themeCtx.theme.error
                : getStatusColor(entry.agent.status, themeCtx.theme)

            const displayName = () => truncate(entry.agent.name, nameMaxLen)

            return (
              <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={idx() > 0 ? 1 : 0}>
                <text fg={themeCtx.theme.textMuted}>{separator()}</text>

                <box flexDirection="row">
                  <text fg={color()}>{getStatusIcon(entry.agent.status)} </text>
                  <text fg={themeCtx.theme.text} attributes={1}>{displayName()}</text>
                  <text fg={themeCtx.theme.textMuted}> ({entry.agent.engine})</text>
                  <Show when={entry.agent.stepIndex !== undefined && entry.agent.totalSteps !== undefined}>
                    <text fg={themeCtx.theme.textMuted}> • Step {entry.agent.stepIndex! + 1}/{entry.agent.totalSteps}</text>
                  </Show>
                </box>

                <box flexDirection="row" paddingLeft={2}>
                  <text fg={themeCtx.theme.textMuted}>{"Status:".padEnd(labelWidth)}</text>
                  <text fg={color()}>{entry.agent.status}</text>
                </box>

                <Show when={!!entry.failedReason}>
                  <box flexDirection="row" paddingLeft={2}>
                    <text fg={themeCtx.theme.textMuted}>{"Failed reason:".padEnd(labelWidth)}</text>
                    <text fg={themeCtx.theme.error}>{truncate(entry.failedReason!, 60)}</text>
                  </box>
                </Show>

                <Show when={!entry.failedReason && !!entry.agent.error}>
                  <box flexDirection="row" paddingLeft={2}>
                    <text fg={themeCtx.theme.textMuted}>{"Error:".padEnd(labelWidth)}</text>
                    <text fg={themeCtx.theme.error}>{truncate(entry.agent.error!, 60)}</text>
                  </box>
                </Show>

                <Show when={entry.monitoringId !== undefined}>
                  <box flexDirection="row" paddingLeft={2}>
                    <text fg={themeCtx.theme.textMuted}>{"Monitor ID:".padEnd(labelWidth)}</text>
                    <text fg={themeCtx.theme.info}>{String(entry.monitoringId)}</text>
                  </box>
                </Show>

                <Show when={!!entry.sessionId}>
                  <box flexDirection="row" paddingLeft={2}>
                    <text fg={themeCtx.theme.textMuted}>{"Session ID:".padEnd(labelWidth)}</text>
                    <text fg={themeCtx.theme.info}>{truncate(entry.sessionId!, 36)}</text>
                  </box>
                </Show>

                <Show when={!!entry.logPath}>
                  <box flexDirection="row" paddingLeft={2}>
                    <text fg={themeCtx.theme.textMuted}>{"Log file:".padEnd(labelWidth)}</text>
                    <text fg={themeCtx.theme.mutedBlue}>{truncate(entry.logPath!, 50)}</text>
                  </box>
                </Show>

                <box flexDirection="row" paddingLeft={2}>
                  <text fg={themeCtx.theme.textMuted}>{"Recovery:".padEnd(labelWidth)}</text>
                  <Show when={entry.agent.status === "failed"}>
                    <text fg={themeCtx.theme.error}>✗ {entry.resumableReason}</text>
                  </Show>
                  <Show when={entry.agent.status !== "failed"}>
                    <text fg={entry.isResumable ? themeCtx.theme.success : themeCtx.theme.warning}>
                      {entry.isResumable ? "✓" : "✗"} {entry.resumableReason}
                    </text>
                  </Show>
                </box>

                <box flexDirection="row" paddingLeft={2} gap={2} paddingTop={1}>
                  <Show when={entry.isResumable && (entry.agent.status === "paused" || entry.agent.status === "awaiting")}>
                    <box
                      paddingLeft={1}
                      paddingRight={1}
                      backgroundColor={themeCtx.theme.success}
                      onMouseDown={() => props.onContinue(entry.agent.id)}
                    >
                      <text fg={themeCtx.theme.background} attributes={1}>[C] Continue</text>
                    </box>
                  </Show>

                  <Show when={entry.agent.status !== "failed"}>
                    <box
                      paddingLeft={1}
                      paddingRight={1}
                      backgroundColor={themeCtx.theme.error}
                      onMouseDown={() => props.onMarkFailed(entry.agent.id)}
                    >
                      <text fg={themeCtx.theme.background}>[F] Mark Failed</text>
                    </box>
                  </Show>

                  <Show when={entry.monitoringId !== undefined}>
                    <box
                      paddingLeft={1}
                      paddingRight={1}
                      border
                      borderColor={themeCtx.theme.borderSubtle}
                      onMouseDown={() => props.onOpenLog(entry.agent.id)}
                    >
                      <text fg={themeCtx.theme.info}>[L] Open Log</text>
                    </box>
                  </Show>
                </box>
              </box>
            )
          }}
        </For>
      </Show>
    </box>
  )
}
