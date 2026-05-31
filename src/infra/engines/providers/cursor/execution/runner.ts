import { spawnProcess } from '../../../../process/spawn.js';
import { buildCursorExecCommand } from './commands.js';
import { metadata } from '../metadata.js';
import { ENV } from '../config.js';
import { formatThinking, formatCommand, formatResult, formatStatus } from '../../../../../shared/formatters/outputMarkers.js';
import { debug } from '../../../../../shared/logging/logger.js';
import {
  type ProviderRunOptions,
  type ProviderRunResult,
  validateAndNormalizeOptions,
  getProviderCapabilities,
  normalizeText,
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

export type RunCursorOptions = ProviderRunOptions;
export type RunCursorResult = ProviderRunResult;

const toolNameMap = new Map<string, string>();
let accumulatedThinking = '';

function formatStreamJsonLine(line: string): string[] | null {
  try {
    const json = JSON.parse(line);

    if (json.type === 'system' && json.subtype === 'init') {
      return null;
    }

    if (json.type === 'user' && json.message) {
      return [formatStatus('Cursor is analyzing your request...')];
    }

    if (json.type === 'thinking') {
      if (json.subtype === 'delta' && json.text) {
        accumulatedThinking += json.text;
        return null;
      } else if (json.subtype === 'completed') {
        if (accumulatedThinking) {
          const result = formatThinking(accumulatedThinking);
          accumulatedThinking = '';
          return [result];
        }
        return null;
      }
    }

    if (json.type === 'tool_call') {
      const toolCallObj = json.tool_call;
      const toolKey = Object.keys(toolCallObj || {}).find((k: string) => k.endsWith('ToolCall'));
      const toolName = toolKey ? toolKey.replace('ToolCall', '') : 'tool';

      if (json.subtype === 'started') {
        return [formatCommand(toolName, 'started')];
      } else if (json.subtype === 'completed') {
        const toolData = toolCallObj?.[toolKey!];
        const result = toolData?.result;

        if (result?.error) {
          const errorMsg = typeof result.error === 'string'
            ? result.error
            : (result.error?.message || JSON.stringify(result.error));
          return [formatCommand(toolName, 'error') + '\n' + formatResult(errorMsg, true)];
        } else if (result?.success !== undefined) {
          const preview = previewOutput(result.success, 150);
          return [formatCommand(toolName, 'success') + '\n' + formatResult(preview || 'done', false)];
        }
        return [formatCommand(toolName, 'success')];
      }
    }

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
      return [`⏱️  Duration: ${json.duration_ms}ms | Cost: $${json.total_cost_usd} | Tokens: ${json.usage.input_tokens}in/${json.usage.output_tokens}out`];
    }

    return null;
  } catch {
    return null;
  }
}

export async function runCursor(options: RunCursorOptions): Promise<RunCursorResult> {
  const caps = getProviderCapabilities('cursor');
  const sharedOpts = validateAndNormalizeOptions(options, caps, 'Cursor');

  const { prompt, resumeSessionId, resumePrompt, env, onData, onErrorData, onSessionId, abortSignal, timeout = 1800000 } = options;

  const cursorConfigDir = resolveHomeDir(ENV.CURSOR_HOME, 'cursor', env);
  const mergedEnv = mergeEnv(env, { CURSOR_CONFIG_DIR: cursorConfigDir });
  const inheritTTY = false;

  const { command, args } = buildCursorExecCommand({
    ...sharedOpts,
    cursorConfigDir,
  });

  debug(`Cursor runner - prompt length: ${prompt.length}, lines: ${prompt.split('\n').length}`);
  debug(`Cursor runner - args count: ${args.length}, model: ${sharedOpts.model ?? 'auto'}`);

  const state = createStreamProcessingState();

  const handleStreamLine = (line: string, json: Record<string, unknown> | null): void => {
    if (!line.trim()) return;

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

  const onStderr = createStderrHandler(state, (chunk) => {
    const out = normalizeText(chunk);

    if (out.includes('ConnectError: [invalid_argument]') || out.includes('Error =')) {
      onErrorData?.('⚠️  Cursor Error: This is commonly related to plan mode. You may need to check if you\'re in plan mode to use pro models.\n');
    }

    onErrorData?.(out);
  });

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
      errorMessage = extractJsonError(errorOutput) || `Cursor CLI exited with code ${result.exitCode}`;
    }

    if (onErrorData) {
      onErrorData(`\n[ERROR] ${errorMessage}\n`);
    }

    throw new Error(errorMessage);
  }

  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
