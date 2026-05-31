/**
 * Base types and interfaces for the engine plugin system
 */

import type { EngineRunOptions, EngineRunResult } from './types.js';

/**
 * Engine metadata - describes the engine for auto-discovery
 */
export interface EngineCapabilities {
  supportsReasoningEffort?: boolean;
  supportsResume?: boolean;
  supportsModelOverride?: boolean;
  supportedModels?: string[];
}

export interface EngineMetadata {
  id: string;
  name: string;
  description: string;
  cliCommand: string;
  cliBinary: string;
  installCommand: string;
  defaultModel?: string;
  defaultModelReasoningEffort?: 'low' | 'medium' | 'high';
  capabilities?: EngineCapabilities;
  order?: number;
  experimental?: boolean;
  icon?: string;
}

/**
 * Authentication module interface - all engines must implement these
 */
export interface EngineAuthModule {
  /** Check if the engine is authenticated */
  isAuthenticated(options?: unknown): Promise<boolean>;
  /** Ensure authentication, prompting user if needed */
  ensureAuth(options?: unknown): Promise<boolean>;
  /** Clear authentication credentials */
  clearAuth(options?: unknown): Promise<void>;
  /** Get the next auth menu action based on current state */
  nextAuthMenuAction(options?: unknown): Promise<'login' | 'logout'>;
}

/**
 * MCP (Model Context Protocol) configuration for an engine
 */
export interface EngineMCPConfig {
  /** Whether this engine supports MCP */
  supported: boolean;
  /** Configure MCP servers for this engine */
  configure?: (workflowDir: string) => Promise<void>;
  /** Remove MCP configuration */
  cleanup?: (workflowDir: string) => Promise<void>;
  /** Check if MCP is configured */
  isConfigured?: (workflowDir: string) => Promise<boolean>;
}

/**
 * Complete engine module interface
 * All engines must export these to be auto-discovered
 */
export interface EngineModule {
  /** Engine metadata */
  metadata: EngineMetadata;
  /** Authentication module */
  auth: EngineAuthModule;
  /** Main execution function */
  run: (options: EngineRunOptions) => Promise<EngineRunResult>;
  /** Optional: Sync engine-specific configuration */
  syncConfig?: (options?: unknown) => Promise<void>;
  /** Optional: Called when engine is registered */
  onRegister?: () => void;
  /** Optional: Called when engine is loaded */
  onLoad?: () => void;
  /** Optional: MCP configuration for workflow signals */
  mcp?: EngineMCPConfig;
}

/**
 * Type guard to check if an object is a valid EngineModule
 */
export function isEngineModule(obj: unknown): obj is EngineModule {
  if (!obj || typeof obj !== 'object') return false;
  const candidate = obj as Partial<EngineModule>;
  return (
    !!candidate.metadata &&
    typeof candidate.metadata === 'object' &&
    !!candidate.auth &&
    typeof candidate.auth === 'object' &&
    typeof candidate.run === 'function'
  );
}
