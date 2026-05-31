import { spawnProcess } from '../../../../process/spawn.js';
import { buildCcrExecCommand } from './commands.js';
import { metadata } from '../metadata.js';
import { ENV } from '../config.js';
import { logger } from '../../../../../shared/logging/index.js';
import { createTelemetryCapture } from '../../../../../shared/telemetry/index.js';
import {
  formatThinking,
  formatCommand,
  formatResult,
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

export type RunCcrOptions = ProviderRunOptions;
export type RunCcrResult = ProviderRunResult;

const toolNameMap = new Map<string, string>();

function formatStreamJsonLine(line: string): string[] | null {
  try {
    const json = JSON.parse(line);

    if (json.type === 'assistant' && json.message?.content) {
      const parts: string[] = [];
      for (const content of json.message.content) {
        if (content.type === 'text') {
          parts.push(content.text);
        } else if (content.type === 'thinking') {
          parts.push(formatThinking(content.text));
        } else if (content.type === 'tool_use') {
          if (content.id && content.name) {
            toolNameMap.set(content.id, content.name);
          }
          const commandName = content.name || 'tool';
          parts.push(formatCommand(commandName, 'started'));
        }
      }
      return parts.length > 0 ? parts : null;
    } else if (json.type === 'user' && json.message?.content) {
      const parts: string[] = [];
      for (const content of json.message.content) {
        if (content.type === 'tool_result') {
          const toolName = content.tool_use_id ? toolNameMap.get(content.tool_use_id) : undefined;
          const commandName = toolName || 'tool';

          if (content.tool_use_id) {
            toolNameMap.delete(content.tool_use_id);
          }

          const preview = previewOutput(content.content);

          if (content.is_error) {
            parts.push(formatCommand(commandName, 'error') + '\n' + formatResult(preview, true));
          } else {
            parts.push(formatCommand(commandName, 'success') + '\n' + formatResult(preview, false));
          }
        }
      }
      return parts.length > 0 ? parts : null;
    } else if (json.type === 'result') {
      const cacheRead = json.usage.cache_read_input_tokens || 0;
      const cacheCreation = json.usage.cache_creation_input_tokens || 0;
      const totalCached = cacheRead + cacheCreation;
      const totalIn = json.usage.input_tokens + totalCached;

      const tokensDisplay = totalCached > 0
        ? `${totalIn}in/${json.usage.output_tokens}out (${totalCached} cached)`
        : `${totalIn}in/${json.usage.output_tokens}out`;

      return [`⏱️  Duration: ${json.duration_ms}ms | Cost: $${json.total_cost_usd} | Tokens: ${tokensDisplay}`];
    }

    return null;
  } catch {
    return null;
  }
}

function resolveCcrEnv(env?: NodeJS.ProcessEnv, ccrConfigDir?: string): NodeJS.ProcessEnv {
  return mergeEnv(env, {
    CCR_CONFIG_DIR: ccrConfigDir,
  });
}

export async function runCcr(options: RunCcrOptions): Promise<RunCcrResult> {
  const caps = getProviderCapabilities('ccr');
  const sharedOpts = validateAndNormalizeOptions(options, caps, 'Ccr');

  const { prompt, resumeSessionId, resumePrompt, model, env, onData, onErrorData, onSessionId, abortSignal, timeout = 1800000 } = options;

  const ccrConfigDir = resolveHomeDir(ENV.CCR_HOME, 'ccr', env);
  const mergedEnv = resolveCcrEnv(env, ccrConfigDir);
  const inheritTTY = false;

  const { command, args } = buildCcrExecCommand(sharedOpts);

  logger.debug(`CCR runner - prompt length: ${prompt.length}, lines: ${prompt.split('\n').length}`);
  logger.debug(`CCR runner - args count: ${args.length}, model: ${sharedOpts.model ?? 'default'}`);

  const telemetryCapture = createTelemetryCapture('claude', model, prompt, sharedOpts.workingDir);
  const state = createStreamProcessingState();

  const handleStreamLine = (line: string, _json: Record<string, unknown> | null): void => {
    if (!line.trim()) return;

    telemetryCapture.captureFromStreamJson(line);

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
      stdinInput: resumeSessionId ? resumePrompt : prompt,
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

  flushBuffer(state, handleStreamLine, { onSessionId });

  if (result.exitCode !== 0 || state.capturedError) {
    let errorMessage = state.capturedError;

    if (!errorMessage) {
      const errorOutput = result.stderr.trim() || result.stdout.trim();
      errorMessage = extractJsonError(errorOutput) || `CCR CLI exited with code ${result.exitCode}`;
    }

    logger.error('CCR CLI execution failed', {
      exitCode: result.exitCode,
      error: errorMessage,
      command: `${command} ${args.join(' ')}`,
    });

    if (onErrorData) {
      onErrorData(`\n[ERROR] ${errorMessage}\n`);
    }

    throw new Error(errorMessage);
  }

  telemetryCapture.logCapturedTelemetry(result.exitCode);

  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
