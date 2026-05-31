/** @jsxImportSource @opentui/solid */
/**
 * App Shell Component
 *
 * Main application with routing and layout.
 */

import { Match, Show, Switch, For, createSignal, createEffect } from "solid-js"
import { useTerminalDimensions, useKeyboard, useRenderer } from "@opentui/solid"
import { TextAttributes } from "@opentui/core"
import { useKV } from "@tui/shared/context/kv"
import { useToast } from "@tui/shared/context/toast"
import { Toast } from "@tui/shared/ui/toast"
import { useTheme } from "@tui/shared/context/theme"
import { useSession } from "@tui/shared/context/session"
import { useUpdateNotifier } from "@tui/shared/context/update-notifier"
import { Home } from "@tui/routes/home"
import { Workflow } from "@tui/routes/workflow"
import { Onboard } from "@tui/routes/onboard"
import { homedir } from "os"
import { WorkflowEventBus } from "../../workflows/events/index.js"
import { debug, otel_debug } from "../../shared/logging/logger.js"
import { LOGGER_NAMES } from "../../shared/logging/otel-logger.js"
import { MonitoringCleanup } from "../../agents/monitoring/index.js"
import { VERSION } from "../../runtime/version.js"
import { getWorkflowExecutionGateway } from "../../workflows/gateway/index.js"
import type { GatewayEvent, PreviewResult, PreviewBlockingIssue, PreviewAgent, PreviewChain, PreviewImport } from "../../workflows/gateway/types.js"
import type { TracksConfig, ConditionGroup } from "../../workflows/templates/types"
import type { InitialToast } from "./app"
import { exitTUI } from "./exit"

function ConfirmPreview(props: {
  preview: PreviewResult
  onConfirm: () => void
  onDeny: () => void
}) {
  const themeCtx = useTheme()
  const dimensions = useTerminalDimensions()
  const [scrollOffset, setScrollOffset] = createSignal(0)

  const hasErrors = () => props.preview.hasErrors
  const errors = () => props.preview.blockingIssues.filter(i => i.type === 'error')
  const warnings = () => props.preview.blockingIssues.filter(i => i.type === 'warning')
  const numErrors = () => errors().length
  const numWarnings = () => warnings().length

  useKeyboard((evt) => {
    if (evt.name === 'arrowUp') {
      evt.preventDefault()
      setScrollOffset(Math.max(0, scrollOffset() - 1))
      return
    }
    if (evt.name === 'arrowDown') {
      evt.preventDefault()
      setScrollOffset(scrollOffset() + 1)
      return
    }
    if (!hasErrors() && (evt.name === 'y' || evt.name === 'Y' || evt.name === 'enter')) {
      evt.preventDefault()
      props.onConfirm()
      return
    }
    if (evt.name === 'n' || evt.name === 'N' || (evt.ctrl && evt.name === 'c')) {
      evt.preventDefault()
      props.onDeny()
      return
    }
  })

  const lines: Array<{ type: 'header' | 'subheader' | 'line' | 'empty'; text?: string; color?: string }> = []

  const push = (type: 'header' | 'subheader' | 'line' | 'empty', text?: string, color?: string) => {
    lines.push({ type, text, color })
  }

  push('header', `Workflow: ${props.preview.template.name}`)
  push('empty')
  push('subheader', 'Files')
  push('line', `  Template: ${props.preview.templatePath}`, themeCtx.theme.textMuted)
  if (props.preview.specPath) {
    push('line', `  Spec:     ${props.preview.specPath}`, themeCtx.theme.textMuted)
  }
  push('empty')

  if (props.preview.imports.length > 0) {
    push('subheader', `Imports (${props.preview.imports.length})`)
    for (const imp of props.preview.imports) {
      push('line', `  ${imp.name}@${imp.version} (${imp.source})`, themeCtx.theme.textMuted)
    }
    push('empty')
  }

  if (props.preview.subAgents.length > 0) {
    push('subheader', `Sub-agents (${props.preview.subAgents.length})`)
    push('line', `  ${props.preview.subAgents.join(', ')}`, themeCtx.theme.textMuted)
    push('empty')
  }

  push('subheader', `Agents (${props.preview.agents.length})`)
  for (const agent of props.preview.agents) {
    const tagInteractive = agent.isInteractive ? ' [interactive]' : ''
    const tagBehavior = agent.moduleBehavior ? ` [${agent.moduleBehavior}]` : ''
    const modelEffort = agent.modelReasoningEffort ? ` (effort:${agent.modelReasoningEffort})` : ''
    push('line', `  ${agent.agentName}`)
    push('line', `    engine=${agent.engine}, model=${agent.model}${modelEffort}`, themeCtx.theme.textMuted)
    push('line', `    prompts: ${agent.promptPath.join(', ')}`, themeCtx.theme.textMuted)
    if (agent.tracks?.length) {
      push('line', `    tracks:  ${agent.tracks.join(', ')}`, themeCtx.theme.textMuted)
    }
    if (agent.conditions?.length || agent.conditionsAny?.length) {
      const conds = [...(agent.conditions || []), ...(agent.conditionsAny || [])].join(', ')
      push('line', `    conds:   ${conds}`, themeCtx.theme.textMuted)
    }
    if (tagInteractive || tagBehavior) {
      push('line', `    ${tagInteractive}${tagBehavior}`.trim(), themeCtx.theme.textMuted)
    }
  }
  push('empty')

  if (props.preview.chains.length > 0) {
    push('subheader', `Trigger Chains (${props.preview.chains.length})`)
    for (const chain of props.preview.chains) {
      push('line', `  ${chain.name}`, themeCtx.theme.textMuted)
    }
    push('empty')
  }

  if (numErrors() > 0 || numWarnings() > 0) {
    push('subheader', `Issues (${numErrors()} errors, ${numWarnings()} warnings)`)
    for (const issue of props.preview.blockingIssues) {
      const prefix = issue.type === 'error' ? '  ✗ ' : '  ⚠ '
      const color = issue.type === 'error' ? themeCtx.theme.error : themeCtx.theme.warning
      const stepInfo = issue.agentId ? ` (${issue.agentId})` : ''
      push('line', `${prefix}${issue.message}${stepInfo}`, color)
    }
    push('empty')
  }

  const maxContentHeight = () => dimensions().height - 6
  const totalLines = lines.length
  const visibleStart = scrollOffset()
  const visibleEnd = Math.min(visibleStart + maxContentHeight(), totalLines)
  const visibleLines = () => lines.slice(visibleStart, visibleEnd)

  return (
    <box flexDirection="column" width={dimensions().width} height={dimensions().height}>
      <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
        <text fg={themeCtx.theme.primary} attributes={TextAttributes.BOLD}> Dry Run Preview </text>
        <Show when={hasErrors()}>
          <text fg={themeCtx.theme.error}> BLOCKED: Fix errors before proceeding </text>
        </Show>
        <Show when={!hasErrors() && (numErrors() > 0 || numWarnings() > 0)}>
          <text fg={themeCtx.theme.warning}> {numErrors()} errors, {numWarnings()} warnings </text>
        </Show>
        <Show when={totalLines > maxContentHeight()}>
          <text fg={themeCtx.theme.textMuted}> ↑↓ scroll ({visibleStart + 1}-{visibleEnd}/{totalLines}) </text>
        </Show>
      </box>

      <box flexDirection="column" paddingLeft={2} paddingRight={2} height={dimensions().height - 4}>
        <For each={visibleLines()}>
          {(line) => {
            if (line.type === 'header') {
              return <text fg={line.color || themeCtx.theme.text} attributes={TextAttributes.BOLD}>{line.text}</text>;
            }
            if (line.type === 'subheader') {
              return <text fg={line.color || themeCtx.theme.primary} attributes={TextAttributes.BOLD}>{line.text}</text>;
            }
            if (line.type === 'line') {
              return <text fg={line.color || themeCtx.theme.text}>{line.text}</text>;
            }
            return <text fg={themeCtx.theme.text}> </text>;
          }}
        </For>
      </box>

      <box flexDirection="row" justifyContent="center" gap={4}>
        <Show when={hasErrors()}>
          <text fg={themeCtx.theme.error} attributes={TextAttributes.BOLD}> Errors present — cannot proceed </text>
        </Show>
        <Show when={!hasErrors()}>
          <text fg={themeCtx.theme.primary} attributes={TextAttributes.BOLD}>[Y] Run Workflow</text>
        </Show>
        <text fg={themeCtx.theme.textMuted}>[N] Cancel</text>
      </box>
    </box>
  )
}

// Module-level view state for post-processing effects
export let currentView: "home" | "onboard" | "confirm" | "workflow" = "home"

/**
 * Get the clipboard copy method based on OS (lazy loaded)
 */
function getClipboardCopyMethod(): ((text: string) => Promise<void>) | null {
  const os = process.platform

  if (os === "darwin" && Bun.which("osascript")) {
    return async (text: string) => {
      const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
      await Bun.$`osascript -e 'set the clipboard to "${escaped}"'`.nothrow().quiet()
    }
  }

  if (os === "linux") {
    if (process.env.WAYLAND_DISPLAY && Bun.which("wl-copy")) {
      return async (text: string) => {
        const proc = Bun.spawn(["wl-copy"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" })
        proc.stdin.write(text)
        proc.stdin.end()
        await proc.exited.catch(() => {})
      }
    }
    if (Bun.which("xclip")) {
      return async (text: string) => {
        const proc = Bun.spawn(["xclip", "-selection", "clipboard"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" })
        proc.stdin.write(text)
        proc.stdin.end()
        await proc.exited.catch(() => {})
      }
    }
    if (Bun.which("xsel")) {
      return async (text: string) => {
        const proc = Bun.spawn(["xsel", "--clipboard", "--input"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" })
        proc.stdin.write(text)
        proc.stdin.end()
        await proc.exited.catch(() => {})
      }
    }
    if (Bun.which("clip.exe")) {
      return async (text: string) => {
        const proc = Bun.spawn(["clip.exe"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" })
        proc.stdin.write(text)
        proc.stdin.end()
        await proc.exited.catch(() => {})
      }
    }
  }

  if (os === "win32" && Bun.which("powershell")) {
    return async (text: string) => {
      const escaped = text.replace(/"/g, '""')
      await Bun.$`powershell -command "Set-Clipboard -Value \"${escaped}\""`.nothrow().quiet()
    }
  }

  return null
}

let clipboardMethod: ((text: string) => Promise<void>) | null | undefined

async function copyToSystemClipboard(text: string): Promise<void> {
  if (clipboardMethod === undefined) {
    clipboardMethod = getClipboardCopyMethod()
  }
  if (clipboardMethod) {
    await clipboardMethod(text)
  }
}

export function App(props: { initialToast?: InitialToast }) {
  otel_debug(LOGGER_NAMES.TUI, '[AppShell] App component initializing', [])
  const dimensions = useTerminalDimensions()
  const themeCtx = useTheme()
  const session = useSession()
  const updateNotifier = useUpdateNotifier()
  const renderer = useRenderer()
  const toast = useToast()
  const kv = useKV()
  otel_debug(LOGGER_NAMES.TUI, '[AppShell] Hooks initialized', [])

  // Global error handler - any part of the app can emit 'app:error' to show a toast
  const handleAppError = (data: { message: string; duration?: number }) => {
    otel_debug(LOGGER_NAMES.TUI, '[AppShell] App error received: %s', [data.message])
    toast.show({
      variant: "error",
      message: data.message,
      duration: data.duration ?? 0, // permanent by default
    })
  }
  ;(process as NodeJS.EventEmitter).on('app:error', handleAppError)

  // Return to home handler - triggered when user confirms exit from workflow
  const handleReturnHome = () => {
    currentView = "home"
    setView("home")
  }
  ;(process as NodeJS.EventEmitter).on('workflow:return-home', handleReturnHome)

  const [ctrlCPressed, setCtrlCPressed] = createSignal(false)
  let ctrlCTimeout: NodeJS.Timeout | null = null
  const [view, setView] = createSignal<"home" | "onboard" | "confirm" | "workflow">("home")
  const [workflowEventBus, setWorkflowEventBus] = createSignal<WorkflowEventBus | null>(null)
  const [templateTracks, setTemplateTracks] = createSignal<TracksConfig | null>(null)
  const [templateConditionGroups, setTemplateConditionGroups] = createSignal<ConditionGroup[] | null>(null)
  const [initialProjectName, setInitialProjectName] = createSignal<string | null>(null)
  const [onboardingService, setOnboardingService] = createSignal<any>(null)
  const [onboardingEventBus, setOnboardingEventBus] = createSignal<WorkflowEventBus | null>(null)
  const [confirmPreview, setConfirmPreview] = createSignal<PreviewResult | null>(null)

  const gateway = getWorkflowExecutionGateway()

  const handleAdapterReady = () => {
    debug('[AppShell] adapter ready, proceeding with execution')
    gateway.proceedWithExecution()
  }

  const handleConfirmWorkflow = () => {
    debug('[AppShell] user confirmed workflow execution')
    gateway.confirmExecution()
  }

  const handleDenyWorkflow = () => {
    debug('[AppShell] user denied workflow execution')
    gateway.denyExecution()
    currentView = "home"
    setView("home")
  }

  gateway.onEvent((event: GatewayEvent) => {
    switch (event.type) {
      case 'onboarding:required': {
        const { template } = event
        const hasTracks = !!(template.tracks && Object.keys(template.tracks.options).length > 0)
        const hasConditionGroups = !!(template.conditionGroups && template.conditionGroups.length > 0)
        if (hasTracks) setTemplateTracks(template.tracks!)
        if (hasConditionGroups) setTemplateConditionGroups(template.conditionGroups!)
        setInitialProjectName(null)
        setOnboardingEventBus(gateway.onboardingEventBus)
        setOnboardingService(gateway.onboardingService)
        if (gateway.onboardingEventBus) {
          gateway.onboardingEventBus.on('onboard:completed', (e: any) => {
            debug('[AppShell] onboard:completed result=%o', e.result)
            gateway.completeOnboarding(e.result)
          })
          gateway.onboardingEventBus.on('onboard:cancelled', () => {
            debug('[AppShell] onboard:cancelled')
            gateway.cancelOnboarding()
          })
        }
        currentView = "onboard"
        setView("onboard")
        break
      }
      case 'onboarding:cancelled': {
        currentView = "home"
        setView("home")
        break
      }
      case 'confirm:required': {
        setConfirmPreview(event.preview)
        currentView = "confirm"
        setView("confirm")
        break
      }
      case 'execute:ready': {
        setConfirmPreview(null)
        setWorkflowEventBus(event.eventBus)
        currentView = "workflow"
        setView("workflow")
        break
      }
      case 'execute:failed': {
        debug('[AppShell] execution failed: %s', event.error.message)
        break
      }
      default:
        break
    }
  })

  const handleStartWorkflow = () => {
    otel_debug(LOGGER_NAMES.TUI, '[AppShell] handleStartWorkflow called', [])
    const cwd = process.env.CODEMACHINE_CWD || process.cwd()
    gateway.submit({ type: 'start-tui', cwd })
  }

  createEffect(() => {
    if (view() === "workflow") {
      MonitoringCleanup.registerWorkflowHandlers({
        onStop: () => {
          ;(process as NodeJS.EventEmitter).emit('workflow:stopping')
        },
        onExit: () => {
          renderer.destroy()
        },
      })
    }
  })

  useKeyboard((evt) => {
    if (evt.ctrl && evt.name.toLowerCase() === "t") {
      evt.preventDefault()
      const newMode = themeCtx.mode === "dark" ? "light" : "dark"
      themeCtx.setMode(newMode)
      kv.set("theme", newMode)
      toast.show({ variant: "info", message: `Theme: ${newMode}`, duration: 2000 })
      return
    }

    if (evt.ctrl && evt.name === "c") {
      evt.preventDefault()

      // Check if there's a text selection - if so, copy it instead of exiting
      const selection = renderer.getSelection()
      if (selection && selection.isActive) {
        const selectedText = selection.getSelectedText()
        if (selectedText && selectedText.length > 0) {
          // OSC52 via renderer.writeOut
          const base64 = Buffer.from(selectedText).toString("base64")
          const osc52 = `\x1b]52;c;${base64}\x07`
          const finalOsc52 = process.env.TMUX ? `\x1bPtmux;\x1b${osc52}\x1b\\` : osc52
          // @ts-expect-error writeOut exists on renderer
          renderer.writeOut(finalOsc52)
          // Also try system clipboard
          copyToSystemClipboard(selectedText)
            .then(() => toast.show({ variant: "info", message: "Copied to clipboard", duration: 1500 }))
            .catch(() => toast.show({ variant: "error", message: "Failed to copy", duration: 1500 }))
          renderer.clearSelection()
          return
        }
      }

      if (view() === "workflow") {
        void MonitoringCleanup.triggerCtrlCFromUI()
        return
      }
      if (ctrlCPressed()) {
        if (ctrlCTimeout) clearTimeout(ctrlCTimeout)
        renderer.destroy()
        if (process.stdout.isTTY) {
          process.stdout.write('\x1b[2J\x1b[H\x1b[?25h')
        }
        exitTUI(0)
      } else {
        setCtrlCPressed(true)
        toast.show({ variant: "warning", message: "Press Ctrl+C again to exit", duration: 3000 })
        ctrlCTimeout = setTimeout(() => {
          setCtrlCPressed(false)
          ctrlCTimeout = null
        }, 3000)
      }
    }
  })

  const getVersion = () => {
    return VERSION
  }

  const cwd = () => {
    const home = homedir()
    return process.cwd().replace(home, "~")
  }

  return (
    <box width={dimensions().width} height={dimensions().height} backgroundColor={themeCtx.theme.background} flexDirection="column">
      <Toast />
      <box flexGrow={1}>
        <Switch>
          <Match when={view() === "home"}>
            <Home initialToast={props.initialToast} onStartWorkflow={handleStartWorkflow} />
          </Match>
          <Match when={view() === "onboard"}>
            <Onboard
              tracks={templateTracks() ?? undefined}
              conditionGroups={templateConditionGroups() ?? undefined}
              initialProjectName={initialProjectName()}
              onComplete={(result) => gateway.completeOnboarding(result)}
              onCancel={() => gateway.cancelOnboarding()}
              eventBus={onboardingEventBus() ?? undefined}
              service={onboardingService() ?? undefined}
            />
          </Match>
          <Match when={view() === "confirm"}>
            <ConfirmPreview
              preview={confirmPreview()!}
              onConfirm={handleConfirmWorkflow}
              onDeny={handleDenyWorkflow}
            />
          </Match>
          <Match when={view() === "workflow"}>
            <Workflow eventBus={workflowEventBus()} onAdapterReady={handleAdapterReady} />
          </Match>
        </Switch>
      </box>

      <Show when={view() === "home"}>
        <box height={1} flexShrink={0} backgroundColor={themeCtx.theme.backgroundPanel}>
          <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
            <box flexDirection="row" gap={1}>
              <box paddingLeft={1} paddingRight={1} backgroundColor={themeCtx.theme.backgroundElement}>
                <text fg={themeCtx.theme.text}>Code<span style={{ bold: true }}>Machine</span></text>
              </box>
              <text fg={themeCtx.theme.textMuted}>v{getVersion()}</text>
              <Show when={updateNotifier.updateAvailable}>
                <text fg={themeCtx.theme.warning}>Update: v{String(updateNotifier.latestVersion)}</text>
              </Show>
              <text fg={themeCtx.theme.textMuted}>{cwd()}</text>
            </box>
            <box flexDirection="row">
              <text fg={themeCtx.theme.textMuted}>Template: </text>
              <Show when={session.templateName} fallback={
                <text fg={themeCtx.theme.textMuted}>No Templates</text>
              }>
                <text fg={themeCtx.theme.primary} attributes={TextAttributes.BOLD}>
                  {String(session.templateName).toUpperCase()}
                </text>
              </Show>
            </box>
          </box>
        </box>
      </Show>
    </box>
  )
}
