/**
 * Engine Selection
 *
 * Selects the appropriate engine for step execution with fallback logic.
 */

import { registry } from '../../infra/engines/index.js';
import type { EngineCapabilities } from '../../infra/engines/core/types.js';
import { capabilityErrorMessage } from '../../infra/engines/core/types.js';
import { debug } from '../../shared/logging/logger.js';
import type { WorkflowEventEmitter } from '../events/index.js';

interface StepWithConfig {
  model?: string;
  modelReasoningEffort?: string;
  engine?: string;
  agentId: string;
  agentName?: string;
}

/**
 * Derive the capability keys a step *requires* from its own configuration.
 *
 * If a step explicitly sets a model, the selected engine MUST support model
 * selection – otherwise the configuration is contradictory.
 * Same for reasoningEffort and resume.
 */
export function requiredCapabilitiesForStep(
  step: StepWithConfig,
  isResume: boolean,
): Array<keyof EngineCapabilities> {
  const caps: Array<keyof EngineCapabilities> = [];
  if (step.model) caps.push('model');
  if (step.modelReasoningEffort) caps.push('reasoningEffort');
  if (isResume) caps.push('resume');
  return caps;
}

/**
 * Cache for engine authentication status with TTL
 * Prevents repeated auth checks (which can take 10-30 seconds)
 */
export class EngineAuthCache {
  private cache: Map<string, { isAuthenticated: boolean; timestamp: number }> = new Map();
  private ttlMs: number = 5 * 60 * 1000; // 5 minutes TTL

  /**
   * Check if engine is authenticated (with caching)
   */
  async isAuthenticated(engineId: string, checkFn: () => Promise<boolean>): Promise<boolean> {
    const cached = this.cache.get(engineId);
    const now = Date.now();

    // Return cached value if still valid
    if (cached && (now - cached.timestamp) < this.ttlMs) {
      return cached.isAuthenticated;
    }

    // Cache miss or expired - perform actual check
    const result = await checkFn();

    // Cache the result
    this.cache.set(engineId, {
      isAuthenticated: result,
      timestamp: now
    });

    return result;
  }

  /**
   * Invalidate cache for specific engine
   */
  invalidate(engineId: string): void {
    this.cache.delete(engineId);
  }

  /**
   * Clear entire cache
   */
  clear(): void {
    this.cache.clear();
  }
}

// Global auth cache instance
export const authCache = new EngineAuthCache();

/**
 * Select engine for step execution with fallback logic.
 *
 * @param step - Step definition (may specify an engine override)
 * @param emitter - Event emitter for logging messages
 * @param uniqueAgentId - Unique agent ID for message routing
 * @param requiredCapabilities - Capability keys that the selected engine MUST support.
 *                               Engines missing a required capability are skipped during
 *                               fallback search, producing a clear error if none match.
 */
export async function selectEngine(
  step: StepWithConfig,
  emitter: WorkflowEventEmitter,
  uniqueAgentId: string,
  requiredCapabilities: Array<keyof EngineCapabilities> = [],
): Promise<string> {
  debug(`[step/engine] step.engine=${step.engine} requiredCapabilities=[${requiredCapabilities.join(', ')}]`);

  const meetsCapabilities = (engineId: string): boolean => {
    const caps = registry.getCapabilities(engineId);
    return requiredCapabilities.every(key => caps[key] === true);
  };

  // Determine engine: step override > first authenticated engine
  let engineType: string;
  if (step.engine) {
    debug(`[step/engine] Using step-specified engine: ${step.engine}`);
    engineType = step.engine;

    // If an override is provided but not authenticated, log and fall back
    const overrideEngine = registry.get(engineType);
    debug(`[step/engine] Checking auth for override engine...`);
    const isOverrideAuthed = overrideEngine
      ? await authCache.isAuthenticated(overrideEngine.metadata.id, () => overrideEngine.auth.isAuthenticated())
      : false;
    const overrideMeetsCaps = meetsCapabilities(engineType);
    debug(`[step/engine] isOverrideAuthed=${isOverrideAuthed} meetsCapabilities=${overrideMeetsCaps}`);

    // When the explicitly-configured engine lacks required capabilities, that is
    // a hard error – silently falling back would hide a configuration mismatch.
    if (!overrideMeetsCaps && overrideEngine) {
      const gaps = requiredCapabilities.filter(key => !registry.getCapabilities(engineType)[key]);
      const messages = gaps.map(cap => capabilityErrorMessage(overrideEngine.metadata.name, cap));
      throw new Error(messages.join(' '));
    }

    if (!isOverrideAuthed) {
      // Find first authenticated engine that meets capability requirements (with caching)
      const engines = registry.getAll();
      let fallbackEngine = null as typeof overrideEngine | null;
      for (const eng of engines) {
        if (!meetsCapabilities(eng.metadata.id)) {
          debug(`[step/engine] Skipping ${eng.metadata.id} – missing required capabilities`);
          continue;
        }
        const isAuth = await authCache.isAuthenticated(
          eng.metadata.id,
          () => eng.auth.isAuthenticated()
        );
        if (isAuth) {
          fallbackEngine = eng;
          break;
        }
      }

      // If none authenticated, fall back to registry default (may still require auth)
      if (!fallbackEngine) {
        fallbackEngine = registry.getDefault() ?? null;
      }

      if (fallbackEngine) {
        const pretty = overrideEngine?.metadata.name ?? engineType;
        emitter.logMessage(uniqueAgentId, `${pretty} not authenticated. Fallback to ${fallbackEngine.metadata.name}. Run /login to connect.`);
        engineType = fallbackEngine.metadata.id;
      }
    }
  } else {
    debug(`[step/engine] No step.engine specified, finding authenticated engine...`);
    // Fallback: find first authenticated engine that meets capability requirements (with caching)
    const engines = registry.getAll();
    debug(`[step/engine] Available engines: ${engines.map(e => e.metadata.id).join(', ')}`);
    let foundEngine = null;

    for (const engine of engines) {
      if (!meetsCapabilities(engine.metadata.id)) {
        debug(`[step/engine] Skipping ${engine.metadata.id} – missing required capabilities`);
        continue;
      }
      debug(`[step/engine] Checking auth for engine: ${engine.metadata.id}`);
      const isAuth = await authCache.isAuthenticated(
        engine.metadata.id,
        () => engine.auth.isAuthenticated()
      );
      debug(`[step/engine] Engine ${engine.metadata.id} isAuth=${isAuth}`);
      if (isAuth) {
        foundEngine = engine;
        break;
      }
    }

    if (!foundEngine) {
      debug(`[step/engine] No authenticated engine found, using default`);
      foundEngine = registry.getDefault();
    }

    if (!foundEngine) {
      debug(`[step/engine] No engines registered at all!`);
      throw new Error('No engines registered. Please install at least one engine.');
    }

    // Verify the default/found engine meets capabilities; if not, error clearly
    if (!meetsCapabilities(foundEngine.metadata.id) && requiredCapabilities.length > 0) {
      const gaps = requiredCapabilities.filter(key => !registry.getCapabilities(foundEngine.metadata.id)[key]);
      const messages = gaps.map(cap => capabilityErrorMessage(foundEngine.metadata.name, cap));
      throw new Error(`No authenticated engine supports the required capabilities. ${messages.join(' ')}`);
    }

    engineType = foundEngine.metadata.id;
    debug(`[step/engine] Selected engine: ${engineType}`);
  }

  debug(`[step/engine] Engine determined: ${engineType}`);
  return engineType;
}
