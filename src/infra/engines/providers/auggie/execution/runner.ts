import { spawnProcess } from '../../../../process/spawn.js';
import { buildAuggieRunCommand } from './commands.js';
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
} from '../../_shared/index.js';

export type RunAuggieOptions = ProviderRunOptions;
export type RunAuggieResult = ProviderRunResult;

function resolveAuggieEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const auggieHome = resolveHomeDir(ENV.AUGGIE_HOME, 'auggie', env);
  return mergeEnv(env, {
    AUGMENT_HOME: shouldApplyDefault('AUGMENT_HOME', env) ? auggieHome : undefined,
  });
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
          : 'Auggie reported an unknown error';

  return `${formatCommand('Auggie Error', 'error')}\n${formatResult(dataMessage, true)}`;
}

export async function runAuggie(options: RunAuggieOptions): Promise<RunAuggieResult> {
  const caps = getProviderCapabilities('auggie');
  const sharedOpts = validateAndNormalizeOptions(options, caps, 'Auggie');

  const { prompt, resumeSessionId, resumePrompt, model, env, onData, onErrorData, onTelemetry, onSessionId, abortSignal, timeout = 1800000 } = options;

  const runnerEnv = resolveAuggieEnv(env);
  const { command, args } = buildAuggieRunCommand(sharedOpts);

  args.push('--workspace-root', sharedOpts.workingDir);

  const effectivePrompt = resumeSessionId ? resumePrompt! : prompt;
  args.push(effectivePrompt);

  logger.debug(
    `Auggie runner - prompt length: ${prompt.length}, lines: ${prompt.split('\n').length}, model: ${
      model ?? 'default'
    }`,
  );

  const telemetryCapture = createTelemetryCapture('auggie', model, prompt, sharedOpts.workingDir);
  const state = createStreamProcessingState();
  let isFirstStep = true;

  const handleStreamLine = (line: string, json: Record<string, unknown> | null): void => {
    if (!line.trim() || !json) return;

    if (json.type === 'result') {
      const resultText = typeof json.result === 'string' ? json.result : '';
      const isError = json.is_error === true;

      if (isFirstStep) {
        isFirstStep = false;
        const statusMsg = formatStatus('Auggie is processing your request...');
        onData?.(statusMsg + '\n');
      }

      if (resultText) {
        const formatted = isError ? formatErrorEvent(resultText) : formatMessage(resultText);
        if (formatted) {
          const suffix = formatted.endsWith('\n') ? '' : '\n';
          onData?.(formatted + suffix);
        }
      }

      return;
    }

    telemetryCapture.captureFromStreamJson(line);

    if (onTelemetry) {
      const captured = telemetryCapture.getCaptured();
      if (captured?.tokens) {
        const totalIn =
          (captured.tokens.input ?? 0) + (captured.tokens.cached ?? 0);
        onTelemetry({
          tokensIn: totalIn,
          tokensOut: captured.tokens.output ?? 0,
          cached: captured.tokens.cached,
          cost: captured.cost,
          duration: captured.duration,
        });
      }
    }
  };

  const onStdout = createStdoutHandler(state, {
    onSessionId,
    processLine: handleStreamLine,
  });

  const onStderr = createStderrHandler(state, onErrorData);

  let result;
  try {
    result = await spawnProcess({
      command,
      args,
      cwd: sharedOpts.workingDir,
      env: runnerEnv,
      stdioMode: 'pipe',
      onStdout,
      onStderr,
      signal: abortSignal,
      timeout,
    });
  } catch (error) {
    if (isCommandNotFoundError(error)) {
      throw createCommandNotFoundError(command, metadata, args);
    }
    throw error;
  }

  flushBuffer(state, handleStreamLine, { onSessionId });

  if (result.exitCode !== 0 || state.capturedError) {
    throw createExitCodeError(result.exitCode, result.stderr, result.stdout, 'Auggie', state.capturedError);
  }

  telemetryCapture.logCapturedTelemetry(result.exitCode);

  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
