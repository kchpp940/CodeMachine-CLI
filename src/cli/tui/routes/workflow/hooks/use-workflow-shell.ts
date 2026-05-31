/**
 * Workflow Shell Hook
 *
 * Composes all workflow hooks together and provides a unified interface
 * for the workflow shell components.
 */

import { createEffect } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "@tui/shared/context/theme"
import { useToast } from "@tui/shared/context/toast"
import { useTimer } from "@tui/shared/services"
import { useUIState } from "../context/ui-state"
import { useLogStream } from "./useLogStream"
import { useSubAgentSync } from "./useSubAgentSync"
import { useWorkflowModals } from "./use-workflow-modals"
import { useWorkflowKeyboard } from "./use-workflow-keyboard"
import { useWorkflowEvents } from "./use-workflow-events"
import { useWorkflowHandlers } from "./use-workflow-handlers"
import { useWorkflowComputed } from "./use-workflow-computed"
import { calculateVisibleItems } from "../constants"
import { debug } from "../../../../../shared/logging/logger.js"
import { AgentMonitorService, StatusService } from "../../../../../agents/monitoring/index.js"
import type { WorkflowEventBus } from "../../../../../workflows/events/index.js"
import { exec } from "child_process"
import type { AgentState, SubAgentState } from "../state/types"
import { StepLifecyclePhase } from "../../../../../../workflows/indexing/types.js"

export interface UseWorkflowShellOptions {
  version: string
  currentDir: string
  eventBus?: WorkflowEventBus | null
  onAdapterReady?: () => void
}

export function useWorkflowShell(options: UseWorkflowShellOptions) {
  const { currentDir, eventBus, onAdapterReady } = options

  // Core context hooks
  const themeCtx = useTheme()
  const ui = useUIState()
  const toast = useToast()
  const dimensions = useTerminalDimensions()
  const timer = useTimer()
  const modals = useWorkflowModals()

  // State accessor
  const state = () => ui.state()

  // Helper for visible items calculation
  const getVisibleItems = () => calculateVisibleItems(dimensions()?.height ?? 30)

  // Toast helper
  const showToast = (variant: "success" | "error" | "info" | "warning", message: string, duration = 7000) => {
    toast.show({ variant, message, duration })
  }

  // Computed values
  const computed = useWorkflowComputed({ getState: state })

  // Handlers (needs computed values)
  const handlers = useWorkflowHandlers({
    currentDir,
    actions: ui.actions,
    showToast,
    isWaitingForInput: computed.isWaitingForInput,
    isControllerView: computed.isControllerView
  })

  // Events (adapter, process events)
  const events = useWorkflowEvents({
    currentDir,
    eventBus,
    actions: ui.actions,
    showToast,
    onAdapterReady
  })

  // Sync sub-agents
  useSubAgentSync(() => state(), ui.actions)

  // Log stream - view-aware with status-aware polling
  const logStream = useLogStream({
    monitoringAgentId: () => {
      const s = state()
      if (s.view === 'controller') {
        return s.controllerState?.monitoringId
      }
      return computed.currentAgent()?.monitoringId
    },
    agentStatus: () => {
      const s = state()
      if (s.view === 'controller') {
        return s.controllerState?.status
      }
      return computed.currentAgent()?.status
    },
    visibleLineCount: () => {
      const height = dimensions()?.height ?? 40
      return Math.max(5, height - 9) // Match log-viewer calculation
    }
  })

  // Show toast on workflow status change
  createEffect((prevStatus: string | undefined) => {
    const status = state().workflowStatus
    if (prevStatus && prevStatus !== status) {
      switch (status) {
        case "stopping":
          showToast("warning", "Press Ctrl+C again to exit", 3000)
          break
        case "completed":
          showToast("success", "Workflow completed!", 4000)
          break
        case "stopped":
          showToast("error", "Stopped by user", 3000)
          break
        case "awaiting":
          showToast("warning", "Awaiting - Input Required", 5000)
          break
      }
    }
    return status
  })

  // Update visible item count when terminal dimensions change
  createEffect(() => {
    ui.actions.setVisibleItemCount(getVisibleItems())
  })

  // Auto-focus prompt box when input waiting becomes active
  createEffect(() => {
    if (computed.isWaitingForInput() && (computed.isShowingRunningAgent() || computed.isControllerView())) {
      handlers.setIsPromptBoxFocused(true)
    } else if (!computed.isWaitingForInput()) {
      handlers.setIsPromptBoxFocused(false)
    }
  })

  // Single-agent auto-collapse logic
  createEffect(() => {
    const s = state()
    if (s.agents.length === 1) {
      if (!s.timelineCollapsed) {
        debug('[SHELL] Single agent detected, strictly collapsing timeline')
        ui.actions.toggleTimeline()
      }
    }
  })

  // Layout calculations
  const MIN_WIDTH_FOR_SPLIT_VIEW = 100
  const showOutputPanel = () => (dimensions()?.width ?? 80) >= MIN_WIDTH_FOR_SPLIT_VIEW

  // Helper to get monitoring ID for an agent
  const getMonitoringId = (uiAgentId: string): number | undefined => {
    const s = state()
    const mainAgent = s.agents.find((a) => a.id === uiAgentId)
    if (mainAgent?.monitoringId !== undefined) return mainAgent.monitoringId
    for (const subAgents of s.subAgents.values()) {
      const subAgent = subAgents.find((sa) => sa.id === uiAgentId)
      if (subAgent?.monitoringId !== undefined) return subAgent.monitoringId
    }
    return undefined
  }

  const handleDiagnosticContinue = async (agentId: string) => {
    const mid = getMonitoringId(agentId)
    if (mid === undefined) {
      showToast("error", "Cannot resume: no monitoring ID found", 3000)
      return
    }

    const s = state()
    const mainAgent = s.agents.find((a) => a.id === agentId)
    let subAgent: SubAgentState | undefined
    if (!mainAgent) {
      for (const subs of s.subAgents.values()) {
        const found = subs.find((sa) => sa.id === agentId)
        if (found) {
          subAgent = found
          break
        }
      }
    }
    const agent: AgentState | SubAgentState | undefined = mainAgent ?? subAgent
    if (!agent) {
      showToast("error", "Agent not found in UI registry", 3000)
      return
    }

    const monitor = AgentMonitorService.getInstance()
    const record = monitor.getAgent(mid)

    // Block CONTINUE for FAILED steps - check both UI status and monitoring record
    if (agent.status === "failed" || record?.status === "failed") {
      const errMsg = agent.error || record?.error || "Step has failed"
      showToast("error", `Cannot continue: step has failed (${errMsg})`, 5000)
      return
    }

    // Block CONTINUE for RUNNING steps
    if (agent.status === "running" || record?.status === "running") {
      showToast("info", "Step is currently running — cannot resume", 3000)
      return
    }

    // Only allow CONTINUE for paused or awaiting steps WITH a sessionId
    if (agent.status === "paused" || agent.status === "awaiting") {
      if (!record?.sessionId) {
        showToast("warning", "Cannot resume: no active session available", 3000)
        return
      }
      ;(process as NodeJS.EventEmitter).emit("workflow:input", { prompt: "" })
      showToast("info", `Resuming ${agent.name}...`, 3000)
      return
    }

    showToast("warning", `Cannot resume agent in '${agent.status}' state`, 3000)
  }

  const handleDiagnosticMarkFailed = (agentId: string) => {
    const mid = getMonitoringId(agentId)
    if (mid === undefined) {
      showToast("error", "Cannot mark failed: no monitoring ID found", 3000)
      return
    }

    ;(process as NodeJS.EventEmitter).emit("workflow:mark-failed", { agentId, monitoringId: mid })
    showToast("warning", `Marking agent ${agentId} as failed...`, 3000)
  }

  const handleDiagnosticOpenLog = (agentId: string) => {
    const mid = getMonitoringId(agentId)
    if (mid === undefined) {
      showToast("error", "Cannot open log: no monitoring ID found", 3000)
      return
    }

    const monitor = AgentMonitorService.getInstance()
    const record = monitor.getAgent(mid)
    if (!record?.logPath) {
      showToast("error", "Log file path not found for this agent", 3000)
      return
    }

    const fs = require("fs")
    const path = require("path")
    const fullLogPath = path.resolve(process.cwd(), record.logPath)

    if (!fs.existsSync(fullLogPath)) {
      showToast("error", `Log file not found: ${fullLogPath}`, 5000)
      return
    }

    const platform = process.platform
    let openCommand: string
    if (platform === "darwin") {
      openCommand = `open "${fullLogPath}"`
    } else if (platform === "win32") {
      openCommand = `start "" "${fullLogPath}"`
    } else {
      openCommand = `xdg-open "${fullLogPath}"`
    }

    exec(openCommand, (err) => {
      if (err) {
        debug('[Diagnostic] Error opening log file: %s', err.message)
        modals.setLogViewerAgentId(agentId)
        showToast("info", `Opened log viewer for ${agentId} (system open failed)`, 3000)
      } else {
        showToast("success", `Opened log in default editor: ${record.logPath}`, 3000)
      }
    })
  }

  // Keyboard navigation
  useWorkflowKeyboard({
    getState: state,
    actions: {
      ...ui.actions,
      toggleTimeline: () => {
        const s = state()
        if (s.view === 'controller') {
          showToast("warning", "Timeline is not available in controller view", 3000)
          return
        }
        if (s.agents.length <= 1) {
          showToast("warning", "Timeline is not available in single agent workflows", 3000)
          return
        }
        ui.actions.toggleTimeline()
      }
    },
    calculateVisibleItems: getVisibleItems,
    isModalBlocking: () =>
      computed.isCheckpointActive() ||
      modals.isLogViewerActive() ||
      modals.isHistoryActive() ||
      modals.isHistoryLogViewerActive() ||
      modals.isChainConfirmActive() ||
      handlers.showStopModal() ||
      events.isErrorModalActive() ||
      handlers.showControllerContinueModal(),
    isPromptBoxFocused: () => handlers.isPromptBoxFocused(),
    isWaitingForInput: computed.isWaitingForInput,
    hasQueuedPrompts: computed.hasQueuedPrompts,
    openLogViewer: modals.setLogViewerAgentId,
    openHistory: () => modals.setShowHistory(true),
    pauseWorkflow: handlers.pauseWorkflow,
    handleSkip: handlers.handleSkip,
    showStopConfirmation: () => handlers.setShowStopModal(true),
    canStop: () => {
      const status = state().workflowStatus
      return status === "running" || status === "paused" || status === "stopping"
    },
    getCurrentAgentId: () => computed.currentAgent()?.id ?? null,
    canFocusPromptBox: () =>
      computed.isWaitingForInput() &&
      (computed.isShowingRunningAgent() || computed.isControllerView()) &&
      !handlers.isPromptBoxFocused(),
    focusPromptBox: () => handlers.setIsPromptBoxFocused(true),
    exitPromptBoxFocus: () => handlers.setIsPromptBoxFocused(false),
    isAutonomousMode: () => state().autonomousMode === 'true' || state().autonomousMode === 'always',
    toggleAutonomousMode: handlers.toggleAutonomousMode,
    showControllerContinue: () => handlers.setShowControllerContinueModal(true),
    hasController: () => !!state().controllerState,
    returnToController: handlers.returnToController,
    toggleDiagnosticPanel: () => ui.actions.toggleDiagnosticPanel(),
    isDiagnosticPanelVisible: () => state().diagnosticPanelVisible,
    diagnosticContinue: handleDiagnosticContinue,
    diagnosticMarkFailed: handleDiagnosticMarkFailed,
    diagnosticOpenLog: handleDiagnosticOpenLog,
    showToast: (type, message, duration) => showToast(type, message, duration),
  })

  return {
    // State
    state,
    dimensions,
    timer,

    // Context
    themeCtx,
    ui,

    // Computed
    ...computed,

    // Handlers
    ...handlers,

    // Events
    errorMessage: events.errorMessage,
    setErrorMessage: events.setErrorMessage,
    isErrorModalActive: events.isErrorModalActive,
    handleErrorModalClose: () => events.setErrorMessage(null),

    // Modals
    modals,

    // Log stream
    logStream,

    // Layout helpers
    showOutputPanel,
    getVisibleItems,
    getMonitoringId,

    // Diagnostic panel
    handleDiagnosticContinue,
    handleDiagnosticMarkFailed,
    handleDiagnosticOpenLog
  }
}
