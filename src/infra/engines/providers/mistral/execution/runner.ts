import * as path from 'node:path';
import * as fs from 'node:fs';

import { spawnProcess } from '../../../../process/spawn.js';
import { buildMistralExecCommand } from './commands.js';
import { metadata } from '../metadata.js';
import { ENV } from '../config.js';
import { createTelemetryCapture } from '../../../../../shared/telemetry/index.js';
import type { ParsedTelemetry } from '../../../core/types.js';
import {
  formatThinking,
  formatCommand,
  formatResult,
  formatStatus,
  formatDuration,
  formatCost,
  formatTokens,
  addMarker,
  SYMBOL_BULLET,
} from '../../../../../shared/formatters/outputMarkers.js';
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
  extractJsonError,
  resolveHomeDir,
  mergeEnv,
  previewOutput,
} from '../../_shared/index.js';

export type RunMistralOptions = ProviderRunOptions;
export type RunMistralResult = ProviderRunResult;

function findLatestSessionId(vibeHome: string, startTime: number): string | null {
  const sessionDir = path.join(vibeHome, 'logs', 'session');

  try {
    if (!fs.existsSync(sessionDir)) {
      return null;
    }

    const files = fs.readdirSync(sessionDir)
      .filter(f => f.startsWith('session_') && f.endsWith('.json'))
      .map(f => ({
        name: f,
        path: path.join(sessionDir, f),
        mtime: fs.statSync(path.join(sessionDir, f)).mtimeMs,
      }))
      .filter(f => f.mtime >= startTime)
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) {
      return null;
    }

    const content = fs.readFileSync(files[0].path, 'utf-8');
    const json = JSON.parse(content);
    return json.metadata?.session_id || null;
  } catch {
    return null;
  }
}

const toolNameMap = new Map<string, string>();

function formatStreamJsonLine(line: string): string[] | null {
  try {
    const json = JSON.parse(line);

    const role = json.role || json.type;
    const content = json.content || json.message?.content;

    if (role === 'assistant') {
      if (Array.isArray(json.tool_calls) && json.tool_calls.length > 0) {
        const results: string[] = [];
        for (const toolCall of json.tool_calls) {
          const toolName = toolCall.function?.name || toolCall.name || 'tool';
          const toolId = toolCall.id;
          if (toolId && toolName) {
            toolNameMap.set(toolId, toolName);
          }
          results.push(formatCommand(toolName, 'started'));
        }
        return results;
      }

      if (typeof content === 'string' && content.trim()) {
        return [content];
      } else if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            parts.push(block.text);
          } else if (block.type === 'thinking' && block.text) {
            parts.push(formatThinking(block.text));
          } else if (block.type === 'tool_use') {
            if (block.id && block.name) {
              toolNameMap.set(block.id, block.name);
            }
            parts.push(formatCommand(block.name || 'tool', 'started'));
          }
        }
        return parts.length > 0 ? parts : null;
      }
    } else if (role === 'tool') {
      const toolName = json.name || (json.tool_call_id ? toolNameMap.get(json.tool_call_id) : undefined) || 'tool';

      if (json.tool_call_id) {
        toolNameMap.delete(json.tool_call_id);
      }

      const preview = previewOutput(json.content);
      return [formatCommand(toolName, 'success') + '\n' + formatResult(preview, false)];
    } else if (role === 'user') {
      if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const block of content) {
          if (block.type === 'tool_result') {
            const toolName = block.tool_use_id ? toolNameMap.get(block.tool_use_id) : undefined;
            const commandName = toolName || 'tool';

            if (block.tool_use_id) {
              toolNameMap.delete(block.tool_use_id);
            }

            const preview = previewOutput(block.content);

            if (block.is_error) {
              parts.push(formatCommand(commandName, 'error') + '\n' + formatResult(preview, true));
            } else {
              parts.push(formatCommand(commandName, 'success') + '\n' + formatResult(preview, false));
            }
          }
        }
        return parts.length > 0 ? parts : null;
      }
    } else if (role === 'system' || (json.type === 'system' && json.subtype === 'init')) {
      return [formatStatus('Mistral is analyzing your request...')];
    } else if (json.type === 'result' || json.usage) {
      const cacheRead = json.usage?.cache_read_input_tokens || 0;
      const cacheCreation = json.usage?.cache_creation_input_tokens || 0;
      const totalCached = cacheRead + cacheCreation;
      const totalIn = (json.usage?.input_tokens || 0) + totalCached;

      const durationStr = formatDuration(json.duration_ms);
      const costStr = formatCost(json.total_cost_usd);
      const tokensStr = formatTokens(totalIn, json.usage?.output_tokens || 0, totalCached > 0 ? totalCached : undefined);
      return [addMarker('GRAY', `${SYMBOL_BULLET} `, 'DIM') + `${durationStr} ${addMarker('GRAY', '│', 'DIM')} ${costStr} ${addMarker('GRAY', '│', 'DIM')} ${tokensStr}`];
    }

    return null;
  } catch {
    return null;
  }
}

export async function runMistral(options: RunMistralOptions): Promise<RunMistralResult> {
  const caps = getProviderCapabilities('mistral');
  const sharedOpts = validateAndNormalizeOptions(options, caps, 'Mistral');

  const { prompt, resumeSessionId, resumePrompt, model, env, onData, onErrorData, onTelemetry, onSessionId, abortSignal, timeout = 1800000 } = options;

  const vibeHome = resolveHomeDir(ENV.MISTRAL_HOME, 'vibe', env);
  const mergedEnv = mergeEnv(env, {
    VIBE_HOME: vibeHome,
    MISTRAL_CONFIG_DIR: vibeHome,
  });

  const inheritTTY = false;

  const commandOpts = { ...sharedOpts, prompt: resumeSessionId ? resumePrompt! : prompt };
  const { command, args } = buildMistralExecCommand(commandOpts);

  const telemetryCapture = createTelemetryCapture('mistral', model, prompt, sharedOpts.workingDir);
  const state = createStreamProcessingState();
  const startTime = Date.now();

  const handleStreamLine = (line: string, json: Record<string, unknown> | null): void => {
    if (!line.trim()) return;

    telemetryCapture.captureFromStreamJson(line);

    if (json && !state.sessionIdCaptured && json.session_id && onSessionId) {
      state.sessionIdCaptured = true;
      state.capturedSessionId = json.session_id as string;
      onSessionId(json.session_id as string);
    }

    if (onTelemetry) {
      const captured = telemetryCapture.getCaptured();
      if (captured && captured.tokens) {
        const totalIn = (captured.tokens.input ?? 0) + (captured.tokens.cached ?? 0);
        onTelemetry({
          tokensIn: totalIn,
          tokensOut: captured.tokens.output ?? 0,
          cached: captured.tokens.cached,
          cost: captured.cost,
          duration: captured.duration,
        });
      }
    }

    const formatted = formatStreamJsonLine(line);
    if (formatted?.length) {
      for (const part of formatted) {
        if (!part) continue;
        onData?.(part + '\n');
      }
    }
  };

  const onStdout = createStdoutHandler(state, {
    onSessionId,
    sessionIdField: 'session_id',
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

    const err = error as unknown as { name?: string };
    if (err?.name === 'AbortError' && !state.sessionIdCaptured && onSessionId) {
      const sessionId = findLatestSessionId(vibeHome, startTime);
      if (sessionId) {
        state.sessionIdCaptured = true;
        state.capturedSessionId = sessionId;
        onSessionId(sessionId);
      }
    }

    throw error;
  }

  flushBuffer(state, handleStreamLine, { onSessionId, sessionIdField: 'session_id' });

  if (result.exitCode !== 0 || state.capturedError) {
    let errorMessage = state.capturedError;

    if (!errorMessage) {
      const errorOutput = result.stderr.trim() || result.stdout.trim();
      errorMessage = extractJsonError(errorOutput) || `Mistral CLI exited with code ${result.exitCode}`;
    }

    if (onErrorData) {
      onErrorData(`\n[ERROR] ${errorMessage}\n`);
    }

    throw new Error(errorMessage);
  }

  if (!state.sessionIdCaptured && onSessionId) {
    const sessionId = findLatestSessionId(vibeHome, startTime);
    if (sessionId) {
      state.sessionIdCaptured = true;
      state.capturedSessionId = sessionId;
      onSessionId(sessionId);
    }
  }

  telemetryCapture.logCapturedTelemetry(result.exitCode);

  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
