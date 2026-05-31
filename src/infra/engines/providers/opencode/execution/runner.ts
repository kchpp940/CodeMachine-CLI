import * as path from 'node:path';

import { spawnProcess } from '../../../../process/spawn.js';
import { buildOpenCodeRunCommand } from './commands.js';
import { metadata } from '../metadata.js';
import { ENV } from '../config.js';
import { formatCommand, formatResult, formatStatus, formatMessage } from '../../../../../shared/formatters/outputMarkers.js';
import { logger } from '../../../../../shared/logging/index.js';
import { createTelemetryCapture } from '../../../../../shared/telemetry/index.js';
import type { ParsedTelemetry } from '../../../core/types.js';
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
  createExitCodeError,
  resolveHomeDir,
  mergeEnv,
  shouldApplyDefault,
  truncateText,
} from '../../_shared/index.js';

export type RunOpenCodeOptions = ProviderRunOptions & {
  agent?: string;
};

export type RunOpenCodeResult = ProviderRunResult;

function resolveRunnerEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const opencodeHome = resolveHomeDir(ENV.OPENCODE_HOME, 'opencode', env);

  return mergeEnv(env, {
    XDG_CONFIG_HOME: shouldApplyDefault('XDG_CONFIG_HOME', env) ? path.join(opencodeHome, 'config') : undefined,
    XDG_CACHE_HOME: shouldApplyDefault('XDG_CACHE_HOME', env) ? path.join(opencodeHome, 'cache') : undefined,
    XDG_DATA_HOME: shouldApplyDefault('XDG_DATA_HOME', env) ? path.join(opencodeHome, 'data') : undefined,
  });
}

function formatToolUse(part: unknown): string {
  const partObj = (typeof part === 'object' && part !== null ? part : {}) as Record<string, unknown>;
  const tool = (partObj?.tool as string) ?? 'tool';
  const base = formatCommand(tool, 'success');
  const state = (partObj?.state as Record<string, unknown>) ?? {};

  if (tool === 'bash') {
    const outputRaw =
      typeof state?.output === 'string'
        ? state.output
        : state?.output
          ? JSON.stringify(state.output)
          : '';
    const output = outputRaw?.trim() ?? '';
    if (output) {
      return `${base}\n${formatResult(output, false)}`;
    }
    return base;
  }

  const previewSource =
    (typeof state?.title === 'string' && state.title.trim()) ||
    (typeof state?.output === 'string' && state.output.trim()) ||
    (state?.input && Object.keys(state.input).length > 0 ? JSON.stringify(state.input) : '');

  if (previewSource) {
    const preview = previewSource.trim();
    return `${base}\n${formatResult(truncateText(preview), false)}`;
  }

  return base;
}

function formatStepEvent(type: string, part: unknown): string | null {
  const partObj = (typeof part === 'object' && part !== null ? part : {}) as Record<string, unknown>;
  const reason = typeof partObj?.reason === 'string' ? partObj.reason : undefined;

  if (reason !== 'stop') {
    return null;
  }

  const tokens = partObj?.tokens as Record<string, unknown> | undefined;
  if (!tokens) {
    return null;
  }

  const tokenCache = tokens.cache as Record<string, unknown> | undefined;
  const cache = ((tokenCache?.read as number) ?? 0) + ((tokenCache?.write as number) ?? 0);
  const totalIn = ((tokens.input as number) ?? 0) + cache;
  const tokenSummary = `⏱️  Tokens: ${totalIn}in/${(tokens.output as number) ?? 0}out${cache > 0 ? ` (${cache} cached)` : ''}`;

  return tokenSummary;
}

function formatErrorEvent(error: unknown): string {
  const errorObj = (typeof error === 'object' && error !== null ? error : {}) as Record<string, unknown>;
  const data = errorObj.data as Record<string, unknown> | undefined;
  const dataMessage =
    typeof data?.message === 'string'
      ? data.message
      : typeof errorObj?.message === 'string'
        ? errorObj.message as string
        : typeof errorObj?.name === 'string'
          ? errorObj.name as string
          : 'OpenCode reported an unknown error';

  return `${formatCommand('OpenCode Error', 'error')}\n${formatResult(dataMessage, true)}`;
}

export async function runOpenCode(options: RunOpenCodeOptions): Promise<RunOpenCodeResult> {
  const caps = getProviderCapabilities('opencode');
  const sharedOpts = validateAndNormalizeOptions(options, caps, 'OpenCode');

  const { prompt, resumeSessionId, resumePrompt, agent, env, onData, onErrorData, onTelemetry, onSessionId, abortSignal, timeout = 1800000 } = options;

  const runnerEnv = resolveRunnerEnv(env);
  const { command, args } = buildOpenCodeRunCommand({ ...sharedOpts, agent });

  const runnerStartTime = Date.now();
  logger.debug(
    `OpenCode runner - prompt length: ${prompt.length}, lines: ${prompt.split('\n').length}, agent: ${
      agent ?? 'build'
    }, model: ${sharedOpts.model ?? 'default'}`,
  );

  const telemetryCapture = createTelemetryCapture('opencode', sharedOpts.model, prompt, sharedOpts.workingDir);
  const state = createStreamProcessingState();
  let isFirstStep = true;

  const handleStreamLine = (line: string, json: Record<string, unknown> | null): void => {
    if (!line.trim() || !json) return;

    if (!state.firstJsonLineReceived) {
      logger.debug(`[RUNNER-TIMING] First JSON line received ${Date.now() - runnerStartTime}ms after runner start`);
    }

    const prevCaptured = telemetryCapture.getCaptured();
    telemetryCapture.captureFromStreamJson(line);
    const newCaptured = telemetryCapture.getCaptured();

    if (onTelemetry && newCaptured?.tokens && newCaptured !== prevCaptured) {
      const totalContextIn = (newCaptured.tokens.input ?? 0) + (newCaptured.tokens.cached ?? 0);
      const telemetryPayload = {
        tokensIn: totalContextIn,
        tokensOut: newCaptured.tokens.output ?? 0,
        cached: newCaptured.tokens.cached,
        cost: newCaptured.cost,
        duration: newCaptured.duration,
      };
      logger.debug('[TELEMETRY:2-RUNNER] Emitting onTelemetry → tokensIn=%d (input=%d + cached=%d), tokensOut=%d',
        totalContextIn, newCaptured.tokens.input ?? 0, newCaptured.tokens.cached ?? 0, telemetryPayload.tokensOut);
      onTelemetry(telemetryPayload);
    }

    if (!state.sessionIdCaptured && json.sessionID && onSessionId) {
      state.sessionIdCaptured = true;
      logger.debug(`[SESSION_ID CAPTURED] ${json.sessionID} (${Date.now() - runnerStartTime}ms after runner start)`);
      onSessionId(json.sessionID as string);
    }

    const parsedObj = json as Record<string, unknown>;

    let formatted: string | null = null;
    switch (parsedObj.type) {
      case 'tool_use':
        formatted = formatToolUse(parsedObj.part);
        break;
      case 'step_start':
        if (isFirstStep) {
          isFirstStep = false;
          formatted = formatStatus('OpenCode is analyzing your request...');
        }
        break;
      case 'step_finish':
        formatted = formatStepEvent(parsedObj.type as string, parsedObj.part);
        break;
      case 'text': {
        const textPart = parsedObj.part as Record<string, unknown>;
        const rawText = typeof textPart?.text === 'string' ? textPart.text : '';
        const textValue = rawText.replace(/^\n+/, '');
        formatted = textValue.trim() ? formatMessage(textValue) : null;
        break;
      }
      case 'error':
        formatted = formatErrorEvent(parsedObj.error);
        if (!state.capturedError && parsedObj.error) {
          const errorObj = parsedObj.error as Record<string, unknown>;
          state.capturedError = (errorObj.data as Record<string, unknown>)?.message as string
            ?? errorObj.message as string
            ?? errorObj.name as string
            ?? 'Unknown error';
        }
        break;
      default:
        break;
    }

    if (formatted) {
      const suffix = formatted.endsWith('\n') ? '' : '\n';
      onData?.(formatted + suffix);
    }
  };

  const onStdout = createStdoutHandler(state, {
    onSessionId,
    sessionIdField: 'sessionID',
    processLine: handleStreamLine,
  });

  const onStderr = createStderrHandler(state, onErrorData);

  let result;
  try {
    logger.debug(`[RUNNER-TIMING] Calling spawnProcess at ${Date.now() - runnerStartTime}ms`);
    result = await spawnProcess({
      command,
      args,
      cwd: sharedOpts.workingDir,
      env: runnerEnv,
      stdinInput: resumeSessionId ? resumePrompt : prompt,
      stdioMode: 'pipe',
      onStdout,
      onStderr,
      signal: abortSignal,
      timeout,
    });
    logger.debug(`[RUNNER-TIMING] spawnProcess completed at ${Date.now() - runnerStartTime}ms`);
  } catch (error) {
    if (isCommandNotFoundError(error)) {
      logger.error(`${metadata.name} CLI not found when executing: ${command} ${args.join(' ')}`);
      throw createCommandNotFoundError(command, metadata, args);
    }
    throw error;
  }

  flushBuffer(state, handleStreamLine, { onSessionId, sessionIdField: 'sessionID' });

  const stderr = state.stderrBuffer.trim() || result.stderr.trim();
  const stdout = result.stdout.trim();

  const isStartupError = !stdout && stderr;

  if (result.exitCode !== 0 || state.capturedError || isStartupError) {
    telemetryCapture.logCapturedTelemetry(result.exitCode);
    throw createExitCodeError(result.exitCode, stderr, stdout, 'OpenCode', state.capturedError);
  }

  telemetryCapture.logCapturedTelemetry(result.exitCode);

  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
