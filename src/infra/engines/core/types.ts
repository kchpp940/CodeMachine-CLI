/**
 * Engine abstraction types for Codex and Claude
 */

/**
 * Engine type - now dynamically determined from registry
 * Use registry.getAllIds() to get available engine IDs at runtime
 */
export type EngineType = string;

/**
 * Engine capability flags
 *
 * Each engine declares which features it supports so that the runner can:
 * - Skip unsupported CLI flags when building commands
 * - Produce clear, provider-specific error messages when an unsupported
 *   feature is requested
 * - Filter engines during selection when a step requires a capability
 */
export interface EngineCapabilities {
  /** Whether the engine supports resuming an existing session (e.g. --resume) */
  resume: boolean;
  /** Whether the engine accepts a --model / -m flag to select a model */
  model: boolean;
  /** Whether the engine accepts a working-directory / -C / --cwd flag */
  workingDir: boolean;
  /** Whether the engine streams structured log output (stream-json, etc.) */
  streamLog: boolean;
  /** Whether the engine supports a reasoning-effort / thinking-budget flag */
  reasoningEffort: boolean;
  /** Whether the engine can accept interactive user input during execution */
  interactiveInput: boolean;
}

/**
 * Default capabilities – all features OFF.
 * Engines only need to override the flags they support.
 */
export const DEFAULT_CAPABILITIES: EngineCapabilities = {
  resume: false,
  model: false,
  workingDir: false,
  streamLog: false,
  reasoningEffort: false,
  interactiveInput: false,
};

export interface ParsedTelemetry {
  tokensIn: number;
  tokensOut: number;
  cached?: number;
  cost?: number;
  duration?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

export interface EngineRunOptions {
  prompt: string;
  workingDir: string;
  resumeSessionId?: string;
  resumePrompt?: string;
  model?: string;
  modelReasoningEffort?: 'low' | 'medium' | 'high';
  env?: NodeJS.ProcessEnv;
  onData?: (chunk: string) => void;
  onErrorData?: (chunk: string) => void;
  onTelemetry?: (telemetry: ParsedTelemetry) => void;
  onSessionId?: (sessionId: string) => void;
  abortSignal?: AbortSignal;
  timeout?: number;
}

export interface EngineRunResult {
  stdout: string;
  stderr: string;
}

export interface Engine {
  type: EngineType;
  readonly capabilities: EngineCapabilities;
  run(options: EngineRunOptions): Promise<EngineRunResult>;
}

/**
 * Validate if a string is a valid engine type
 * Basic validation - registry-specific validation should be done at runtime
 */
export function isValidEngineType(type: string): boolean {
  return typeof type === 'string' && type.length > 0;
}

/**
 * Normalize engine type - returns valid engine ID or throws
 * Note: This basic validation can be enhanced when registry access is needed
 */
export function normalizeEngineType(type: string): string {
  if (isValidEngineType(type)) {
    return type;
  }
  throw new Error(`Invalid engine type "${type}". Engine type must be a non-empty string.`);
}

const CAPABILITY_LABELS: Record<keyof EngineCapabilities, string> = {
  resume: 'session resume',
  model: 'model selection',
  workingDir: 'working directory',
  streamLog: 'streaming log output',
  reasoningEffort: 'reasoning effort',
  interactiveInput: 'interactive input',
};

/**
 * Build a human-readable error message when a capability is not supported.
 *
 * @param engineName  Display name of the engine (e.g. "Mistral Vibe")
 * @param capability  The capability key that was requested but unsupported
 */
export function capabilityErrorMessage(engineName: string, capability: keyof EngineCapabilities): string {
  const label = CAPABILITY_LABELS[capability] ?? capability;
  return `${engineName} does not support ${label}.`;
}

/**
 * Capability request descriptor — used by assertEngineCapabilities to know
 * *which* features are being explicitly requested so it can decide whether
 * a missing capability is a hard error or simply inapplicable.
 */
export interface CapabilityRequest {
  model?: string;
  modelReasoningEffort?: string;
  resumeSessionId?: string;
}

/**
 * Assert that the engine's capability set satisfies every feature that is
 * explicitly requested.
 *
 * This is the **single** validation entry-point used by the agent runner,
 * step runner, and controller — no caller should duplicate capability checks.
 *
 * @throws Error with a message built by capabilityErrorMessage for the first
 *         unsatisfied capability, or a combined message if multiple gaps exist.
 */
export function assertEngineCapabilities(
  engineName: string,
  capabilities: EngineCapabilities,
  request: CapabilityRequest,
): void {
  const gaps: Array<keyof EngineCapabilities> = [];

  if (request.model && !capabilities.model) gaps.push('model');
  if (request.modelReasoningEffort && !capabilities.reasoningEffort) gaps.push('reasoningEffort');
  if (request.resumeSessionId && !capabilities.resume) gaps.push('resume');

  if (gaps.length > 0) {
    throw new Error(gaps.map(cap => capabilityErrorMessage(engineName, cap)).join(' '));
  }
}
