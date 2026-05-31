import * as path from 'node:path';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

import { spawnProcess } from '../../../../process/spawn.js';
import { buildCodexCommand } from './commands.js';
import { metadata } from '../metadata.js';
import { ENV } from '../config.js';
import type { ParsedTelemetry } from '../../../core/types.js';
import { formatThinking, formatCommand, formatResult, formatMessage, formatStatus, formatMcpCall, formatMcpResult } from '../../../../../shared/formatters/outputMarkers.js';
import { debug } from '../../../../../shared/logging/logger.js';
import {
  type ProviderRunOptions,
  type ProviderRunResult,
  validateAndNormalizeOptions,
  getProviderCapabilities,
  createStreamProcessingState,
  createStdoutHandler,
  createStderrHandler,
  flushBuffer,
  isCommandNotFoundError,
  createCommandNotFoundError,
  resolveHomeDir,
  mergeEnv,
  previewOutput,
  truncateText,
} from '../../_shared/index.js';

export type RunCodexOptions = ProviderRunOptions;
export type RunCodexResult = ProviderRunResult;

function getSessionPath(sessionId: string, codexHome: string): string | null {
  const now = new Date();
  const year = now.getFullYear().toString();
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  const day = now.getDate().toString().padStart(2, '0');

  const sessionsDir = path.join(codexHome, 'sessions', year, month, day);

  if (!existsSync(sessionsDir)) {
    debug('[SESSION-READER] Sessions directory not found: %s', sessionsDir);
    return null;
  }

  try {
    const files = readdirSync(sessionsDir);
    const sessionFile = files.find(f => f.includes(sessionId) && f.endsWith('.jsonl'));
    if (sessionFile) {
      return path.join(sessionsDir, sessionFile);
    }
  } catch (err) {
    debug('[SESSION-READER] Error reading sessions directory: %s', err);
  }

  return null;
}

function readSessionTelemetry(sessionPath: string): ParsedTelemetry | null {
  if (!existsSync(sessionPath)) {
    debug('[SESSION-READER] File not found: %s', sessionPath);
    return null;
  }

  try {
    const content = readFileSync(sessionPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (
          entry.type === 'event_msg' &&
          entry.payload?.type === 'token_count' &&
          entry.payload?.info?.last_token_usage
        ) {
          const info = entry.payload.info;
          const lastUsage = info.last_token_usage;
          const totalUsage = info.total_token_usage;

          const BASELINE_TOKENS = 12000;
          const contextUsed = Math.max((lastUsage.total_tokens || 0) - BASELINE_TOKENS, 0);

          debug('[SESSION-READER] last_token_usage.total_tokens=%d, contextUsed=%d (after -12k baseline)',
            lastUsage.total_tokens, contextUsed);
          debug('[SESSION-READER] total_token_usage: output=%d, cached=%d',
            totalUsage?.output_tokens, totalUsage?.cached_input_tokens);

          return {
            tokensIn: contextUsed,
            tokensOut: totalUsage?.output_tokens || 0,
            cached: totalUsage?.cached_input_tokens || 0,
          };
        }
      } catch { /* skip malformed */ }
    }
    return null;
  } catch (err) {
    debug('[SESSION-READER] Error: %s', err);
    return null;
  }
}

function formatCodexStreamJsonLine(line: string): string | null {
  try {
    const json = JSON.parse(line);

    if (json.type === 'item.completed' && json.item?.type === 'reasoning') {
      return formatThinking(json.item.text) + '\n';
    }

    if (json.type === 'item.started' && json.item?.type === 'command_execution') {
      const command = json.item.command ?? 'command';
      return formatCommand(command, 'started');
    }

    if (json.type === 'item.completed' && json.item?.type === 'command_execution') {
      const exitCode = json.item.exit_code ?? 0;
      const command = json.item.command;

      if (exitCode === 0) {
        const output = json.item.aggregated_output?.trim() || '';
        const preview = output ? truncateText(output, 100) : 'empty';
        return formatCommand(command, 'success') + '\n' + formatResult(preview, false);
      } else {
        return formatCommand(command, 'error') + '\n' + formatResult(`Exit code ${exitCode}`, true);
      }
    }

    if (json.type === 'item.completed' && json.item?.type === 'agent_message') {
      return formatMessage(json.item.text);
    }

    if (json.type === 'item.completed' && json.item?.type === 'mcp_tool_call') {
      const server = json.item.server ?? 'mcp';
      const tool = json.item.tool ?? 'unknown';
      const status = json.item.status;
      const isError = status === 'failed' || status === 'error';

      let output = formatMcpCall(server, tool, isError ? 'error' : 'completed');

      if (json.item.result?.content) {
        const content = json.item.result.content;
        const textContent = Array.isArray(content)
          ? content.map((c: { text?: string }) => c.text ?? '').join('\n')
          : String(content);
        if (textContent) {
          const preview = truncateText(textContent, 150);
          output += '\n' + formatMcpResult(preview, isError);
        }
      }

      return output;
    }

    if (json.type === 'thread.started' || json.type === 'turn.started' || json.type === 'turn') {
      if (json.type === 'turn.started') {
        return formatStatus('Codex is analyzing your request...');
      }

      if (json.type === 'turn.completed' && json.usage) {
        const { input_tokens, cached_input_tokens, output_tokens } = json.usage;
        const totalIn = input_tokens + (cached_input_tokens || 0);
        return `⏱️  Tokens: ${totalIn}in/${output_tokens}out${cached_input_tokens ? ` (${cached_input_tokens} cached)` : ''}`;
      }
      return null;
    }

    return null;
  } catch {
    return null;
  }
}

export async function runCodex(options: RunCodexOptions): Promise<RunCodexResult> {
  const caps = getProviderCapabilities('codex');
  const sharedOpts = validateAndNormalizeOptions(options, caps, 'Codex');

  const { prompt, resumeSessionId, env, onData, onErrorData, onTelemetry, onSessionId, abortSignal, timeout = 1800000 } = options;

  debug(`[DEBUG codex runner.ts] runCodex called with resumeSessionId=${resumeSessionId}, resumePrompt="${sharedOpts.resumePrompt}"`);

  const codexHome = resolveHomeDir(ENV.CODEX_HOME, 'codex', env);
  const mergedEnv = mergeEnv(env, { CODEX_HOME: codexHome });
  const inheritTTY = false;

  const { command, args } = buildCodexCommand(sharedOpts);

  debug(`Codex runner - prompt length: ${prompt.length}, lines: ${prompt.split('\n').length}`);
  debug(`Codex runner - args count: ${args.length}`);
  debug(
    `Codex runner - CLI: ${command} ${args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(' ')} | stdin preview: ${prompt.slice(0, 120)}`
  );

  const state = createStreamProcessingState();
  let accumulatedTokensOut = 0;

  const handleStreamLine = (line: string, json: Record<string, unknown> | null): void => {
    if (!line.trim()) return;

    if (json) {
      if (json.type === 'thread.started' && json.thread_id && onSessionId && !state.sessionIdCaptured) {
        state.sessionIdCaptured = true;
        state.capturedSessionId = json.thread_id as string;
        debug(`[SESSION_ID CAPTURED] ${json.thread_id}`);
        onSessionId(json.thread_id as string);
      }

      if (!state.capturedError) {
        if (json.type === 'error' && json.message) {
          state.capturedError = json.message as string;
        } else if (json.type === 'turn.failed' && (json.error as Record<string, unknown>)?.message) {
          state.capturedError = (json.error as Record<string, unknown>).message as string;
        }
      }

      if (json.type === 'turn.completed' && onTelemetry && state.capturedSessionId) {
        const sessionPath = getSessionPath(state.capturedSessionId, codexHome);
        if (sessionPath) {
          debug('[SESSION-READER] Reading telemetry from: %s', sessionPath);
          const telemetry = readSessionTelemetry(sessionPath);
          if (telemetry) {
            accumulatedTokensOut += telemetry.tokensOut;
            debug('[SESSION-READER] Accumulated tokensOut: %d (this turn: %d)',
              accumulatedTokensOut, telemetry.tokensOut);

            onTelemetry({
              tokensIn: telemetry.tokensIn,
              tokensOut: accumulatedTokensOut,
              cached: telemetry.cached,
            });
          }
        }
      }
    }

    const formatted = formatCodexStreamJsonLine(line);
    if (formatted) {
      onData?.(formatted + '\n');
    }
  };

  const onStdout = createStdoutHandler(state, {
    sessionIdField: 'thread_id',
    processLine: handleStreamLine,
  });

  const onStderr = createStderrHandler(state, onErrorData);

  let result;
  try {
    result = await spawnProcess({
      command,
      args,
      cwd: sharedOpts.workingDir,
      env: mergedEnv,
      stdinInput: resumeSessionId ? undefined : prompt,
      onStdout: inheritTTY ? undefined : onStdout,
      onStderr: inheritTTY ? undefined : onStderr,
      signal: abortSignal,
      stdioMode: inheritTTY ? 'inherit' : 'pipe',
      timeout,
    });
  } catch (error) {
    if (isCommandNotFoundError(error)) {
      throw createCommandNotFoundError(command, metadata, args);
    }
    throw error;
  }

  flushBuffer(state, handleStreamLine, { sessionIdField: 'thread_id' });

  if (result.exitCode !== 0 || state.capturedError) {
    const errorOutput = state.capturedError || result.stderr.trim() || result.stdout.trim() || 'no error output';
    const lines = errorOutput.split('\n').slice(0, 10);
    const preview = lines.join('\n');
    throw new Error(preview);
  }

  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
