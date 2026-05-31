/** @jsxImportSource @opentui/solid */
import { createSignal, Show, For } from "solid-js"
import { useTerminalDimensions, useKeyboard } from "@opentui/solid"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "@tui/shared/context/theme"
import type { DryPreviewResult, DryPreviewIssue } from "../../../../workflows/preflight/dry-preview.js"

export interface DryPreviewViewProps {
  result: DryPreviewResult
  onConfirm: () => void
  onCancel: () => void
}

export function DryPreviewView(props: DryPreviewViewProps) {
  const themeCtx = useTheme()
  const dimensions = useTerminalDimensions()
  const [scrollOffset, setScrollOffset] = createSignal(0)

  const termWidth = () => dimensions()?.width ?? 80
  const termHeight = () => dimensions()?.height ?? 24
  const visibleHeight = () => termHeight() - 6

  const errors = () => props.result.issues.filter(i => i.severity === 'error')
  const warnings = () => props.result.issues.filter(i => i.severity === 'warning')
  const moduleSteps = () => props.result.steps.filter(s => s.type === 'module')

  const allLines = (): string[] => {
    const lines: string[] = []

    lines.push(`Template:      ${props.result.templateName}`)
    lines.push(`Path:          ${shortenPath(props.result.templatePath)}`)
    lines.push(`Specification: ${props.result.specification ? 'required' : 'not required'}`)
    if (props.result.autonomousMode) {
      lines.push(`Auto Mode:     ${props.result.autonomousMode}`)
    }
    if (props.result.selectedTrack) {
      lines.push(`Track:         ${props.result.selectedTrack}`)
    }
    if (props.result.selectedConditions.length > 0) {
      lines.push(`Conditions:    ${props.result.selectedConditions.join(', ')}`)
    }
    lines.push('')

    if (props.result.imports.length > 0) {
      lines.push('── Import Sources ──────────────────────────────────')
      for (const imp of props.result.imports) {
        lines.push(`  ${imp.name} v${imp.version}`)
      }
      lines.push('')
    }

    if (props.result.controller) {
      lines.push('── Controller ─────────────────────────────────────')
      lines.push(`  Agent:  ${props.result.controller.agentId}`)
      lines.push(`  Engine: ${props.result.controller.resolvedEngine ?? '(default)'}`)
      lines.push(`  Model:  ${props.result.controller.resolvedModel ?? '(engine default)'}`)
      lines.push('')
    }

    lines.push('── Steps ──────────────────────────────────────────')
    for (const step of props.result.steps) {
      if (step.type === 'separator') {
        lines.push(`  ${'─'.repeat(40)}`)
        continue
      }

      const hasIssue = step.promptExists?.some(e => !e)
      const marker = hasIssue ? '✗' : '✓'
      lines.push(`  ${marker} #${step.stepIndex} ${step.agentName ?? step.agentId}`)
      lines.push(`    Engine: ${step.resolvedEngine ?? '(default)'}  Model: ${step.resolvedModel ?? '(default)'}`)
      if (step.modelReasoningEffort) {
        lines.push(`    Effort: ${step.modelReasoningEffort}`)
      }
      if (step.chainedPrompts && step.chainedPrompts.length > 0) {
        lines.push(`    Chained: ${step.chainedPrompts.length} prompt(s)`)
      }
    }
    lines.push('')

    if (props.result.issues.length > 0) {
      lines.push('── Issues ─────────────────────────────────────────')
      for (const err of errors()) {
        const loc = err.stepIndex !== undefined ? `#${err.stepIndex}` : '*'
        lines.push(`  ✗ [${loc}] ${err.message}`)
      }
      for (const warn of warnings()) {
        const loc = warn.stepIndex !== undefined ? `#${warn.stepIndex}` : '*'
        lines.push(`  ⚠ [${loc}] ${warn.message}`)
      }
      lines.push('')
    }

    return lines
  }

  const maxScroll = () => Math.max(0, allLines().length - visibleHeight())
  const visibleLines = () => {
    const all = allLines()
    const offset = Math.min(scrollOffset(), maxScroll())
    return all.slice(offset, offset + visibleHeight())
  }

  function shortenPath(p: string): string {
    const home = process.env.HOME || ''
    if (home && p.startsWith(home)) {
      return '~' + p.slice(home.length)
    }
    return p.length > 50 ? '...' + p.slice(-47) : p
  }

  const statusLine = () => {
    if (props.result.valid) {
      return `✓ Valid — ${moduleSteps().length} step(s), ${errors().length} error(s), ${warnings().length} warning(s)`
    }
    return `✗ Blocked — ${errors().length} error(s) must be fixed before execution`
  }

  const actionHint = () => {
    if (props.result.valid) {
      return '[Enter/y] Confirm  [q] Cancel  [↑↓] Scroll'
    }
    return '[q] Back  [↑↓] Scroll'
  }

  useKeyboard((evt) => {
    if (evt.name === 'down' || evt.name === 'j') {
      evt.preventDefault()
      setScrollOffset(prev => Math.min(prev + 1, maxScroll()))
    } else if (evt.name === 'up' || evt.name === 'k') {
      evt.preventDefault()
      setScrollOffset(prev => Math.max(prev - 1, 0))
    } else if (evt.name === 'q' || (evt.ctrl && evt.name === 'c')) {
      evt.preventDefault()
      props.onCancel()
    } else if (evt.name === 'return' || evt.name === 'y') {
      evt.preventDefault()
      if (props.result.valid) {
        props.onConfirm()
      }
    } else if (evt.name === 'pagedown') {
      evt.preventDefault()
      setScrollOffset(prev => Math.min(prev + visibleHeight(), maxScroll()))
    } else if (evt.name === 'pageup') {
      evt.preventDefault()
      setScrollOffset(prev => Math.max(prev - visibleHeight(), 0))
    }
  })

  return (
    <box
      width={termWidth()}
      height={termHeight()}
      backgroundColor={themeCtx.theme.background}
      flexDirection="column"
    >
      <box
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        flexDirection="column"
        flexGrow={1}
      >
        <box marginBottom={1}>
          <text fg={themeCtx.theme.primary} attributes={TextAttributes.BOLD}>
            WORKFLOW DRY PREVIEW
          </text>
        </box>

        <box flexDirection="column" flexGrow={1}>
          <For each={visibleLines()}>
            {(line) => (
              <box>
                <text fg={themeCtx.theme.text}>{line}</text>
              </box>
            )}
          </For>
        </box>
      </box>

      <box
        height={2}
        paddingLeft={2}
        paddingRight={2}
        flexDirection="column"
        backgroundColor={themeCtx.theme.backgroundPanel}
      >
        <box flexDirection="row" justifyContent="space-between">
          <text fg={props.result.valid ? themeCtx.theme.success : themeCtx.theme.error}>
            {statusLine()}
          </text>
          <text fg={themeCtx.theme.textMuted}>{actionHint()}</text>
        </box>
        <Show when={maxScroll() > 0}>
          <text fg={themeCtx.theme.textMuted}>
            Line {scrollOffset() + 1}-{Math.min(scrollOffset() + visibleHeight(), allLines().length)} of {allLines().length}
          </text>
        </Show>
      </box>
    </box>
  )
}
