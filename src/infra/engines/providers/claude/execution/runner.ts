import * as path from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';

import { spawnProcess } from '../../../../process/spawn.js';
import { buildClaudeExecCommand } from './commands.js';
import { metadata } from '../metadata.js';
import { ENV } from '../config.js';
import { debug } from '../../../../../shared/logging/logger.js';
import type { ParsedTelemetry } from '../../../core/types.js';
import {
  formatThinking,
  formatCommand,
  formatResult,
  formatStatus,
} from '../../../../../shared/formatters/outputMarkers.js';
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
  createExitCodeError,
  extractJsonError,
  resolveHomeDir,
  mergeEnv,
  previewOutput,
} from '../../_shared/index.js';

export type RunClaudeOptions = ProviderRunOptions;
export type RunClaudeResult = ProviderRunResult;

function getSessionPath(sessionId: string, workingDir: string, claudeConfigDir: string): string {
  const slug = workingDir.replace(/\//g, '-');
  return path.join(claudeConfigDir, 'projects', slug, `${sessionId}.jsonl`);
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
        if (entry.type === 'assistant' && entry.message?.usage) {
          const u = entry.message.usage;
          const input = u.input_tokens || 0;
          const output = u.output_tokens || 0;
          const cacheCreation = u.cache_creation_input_tokens || 0;
          const cacheRead = u.cache_read_input_tokens || 0;

          const totalContext = input + cacheCreation + cacheRead;

          debug('[SESSION-READER] input=%d, output=%d, cache_creation=%d, cache_read=%d, TOTAL=%d',
            input, output, cacheCreation, cacheRead, totalContext);

          return {
            tokensIn: totalContext,
            tokensOut: output,
            cached: cacheCreation + cacheRead,
            cacheCreationTokens: cacheCreation,
            cacheReadTokens: cacheRead,
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
    } else if (json.type === 'system' && json.subtype === 'init') {
      return [formatStatus('Claude is analyzing your request...')];
    } else if (json.type === 'result') {
      const cacheRead = json.usage.cache_read_input_tokens || 0;
      const cacheCreation = json.usage.cache_creation_input_tokens || 0;
      const totalCached = cacheRead + cacheCreation;
      const totalIn = json.usage.input_tokens + totalCached;

      return [`⏱️  Tokens: ${totalIn}in/${json.usage.output_tokens}out${totalCached > 0 ? ` (${totalCached} cached)` : ''}`];
    }

    return null;
  } catch {
    return null;
  }
}

function resolveClaudeEnv(env?: NodeJS.ProcessEnv, claudeConfigDir?: string): NodeJS.ProcessEnv {
  return mergeEnv(env, {
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    MCP_TIMEOUT: '900000',
    MCP_TOOL_TIMEOUT: '900000',
    ANTHROPIC_BASE_URL: process.env[ENV.ANTHROPIC_BASE_URL],
    ANTHROPIC_AUTH_TOKEN: process.env[ENV.ANTHROPIC_AUTH_TOKEN],
    ANTHROPIC_API_KEY: process.env[ENV.ANTHROPIC_API_KEY],
    CLAUDE_CODE_OAUTH_TOKEN: process.env[ENV.CLAUDE_OAUTH_TOKEN],
  });
}

export async function runClaude(options: RunClaudeOptions): Promise<RunClaudeResult> {
  const caps = getProviderCapabilities('claude');
  const sharedOpts = validateAndNormalizeOptions(options, caps, 'Claude');

  const { prompt, resumeSessionId, resumePrompt, env, onData, onErrorData, onTelemetry, onSessionId, abortSignal, timeout = 1800000 } = options;

  const claudeConfigDir = resolveHomeDir(ENV.CLAUDE_HOME, 'claude', env);
  const mergedEnv = resolveClaudeEnv(env, claudeConfigDir);
  const inheritTTY = false;

  const { command, args } = buildClaudeExecCommand(sharedOpts);

  const state = createStreamProcessingState();

  const handleStreamLine = (line: string, json: Record<string, unknown> | null): void => {
    if (!line.trim()) return;

    if (json && json.type === 'result' && onTelemetry && state.capturedSessionId) {
      const sessionPath = getSessionPath(state.capturedSessionId, sharedOpts.workingDir, claudeConfigDir);
      debug('[SESSION-READER] Reading telemetry from: %s', sessionPath);
      const telemetry = readSessionTelemetry(sessionPath);
      if (telemetry) {
        onTelemetry(telemetry);
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
      errorMessage = extractJsonError(errorOutput) || `Claude CLI exited with code ${result.exitCode}`;
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
