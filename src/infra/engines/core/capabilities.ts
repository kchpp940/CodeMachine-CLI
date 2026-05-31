import type { EngineModule } from './base.js';
import type { EngineCapabilities } from './base.js';
import { registry } from './registry.js';

export type CapabilityKey = keyof EngineCapabilities;

export interface CapabilityValidationIssue {
  capability: CapabilityKey;
  requested?: unknown;
  supported: boolean;
  supportedValues?: readonly unknown[];
  message: string;
}

export class EngineCapabilityError extends Error {
  public readonly engineId: string;
  public readonly issues: CapabilityValidationIssue[];

  constructor(engineId: string, issues: CapabilityValidationIssue[], message?: string) {
    super(message || capabilityErrorMessage(engineId, issues));
    this.name = 'EngineCapabilityError';
    this.engineId = engineId;
    this.issues = issues;
  }
}

export function capabilityErrorMessage(engineId: string, issues: CapabilityValidationIssue[]): string {
  if (issues.length === 0) return `Engine "${engineId}": capability check passed`;
  if (issues.length === 1) return `Engine "${engineId}": ${issues[0].message}`;
  return `Engine "${engineId}": ${issues.length} capability issues:\n${issues.map(i => `  - ${i.message}`).join('\n')}`;
}

export function checkEngineCapabilities(
  engineId: string,
  requirements: Partial<EngineCapabilities> & { model?: string },
): CapabilityValidationIssue[] {
  const engineModule = registry.get(engineId);
  if (!engineModule) {
    return [{
      capability: 'supportsModelOverride',
      requested: engineId,
      supported: false,
      message: `Engine "${engineId}" is not registered`,
    }];
  }

  const caps = engineModule.metadata.capabilities ?? {};
  const issues: CapabilityValidationIssue[] = [];

  if (requirements.supportsReasoningEffort && !caps.supportsReasoningEffort) {
    issues.push({
      capability: 'supportsReasoningEffort',
      requested: true,
      supported: false,
      message: `reasoning effort is not supported`,
    });
  }

  if (requirements.supportsResume && !caps.supportsResume) {
    issues.push({
      capability: 'supportsResume',
      requested: true,
      supported: false,
      message: `session resume is not supported`,
    });
  }

  if (requirements.model) {
    if (caps.supportsModelOverride === false) {
      issues.push({
        capability: 'supportsModelOverride',
        requested: requirements.model,
        supported: false,
        message: `model override "${requirements.model}" is not supported (engine does not allow model selection)`,
      });
    } else if (caps.supportedModels && caps.supportedModels.length > 0) {
      if (!caps.supportedModels.includes(requirements.model)) {
        issues.push({
          capability: 'supportedModels',
          requested: requirements.model,
          supported: false,
          supportedValues: caps.supportedModels,
          message: `model "${requirements.model}" is not in supported list: ${caps.supportedModels.join(', ')}`,
        });
      }
    }
  }

  return issues;
}

export function assertEngineCapabilities(
  engineId: string,
  requirements: Partial<EngineCapabilities> & { model?: string },
): void {
  const issues = checkEngineCapabilities(engineId, requirements);
  if (issues.length > 0) {
    throw new EngineCapabilityError(engineId, issues);
  }
}

export function getEngineCapabilities(engineId: string): EngineCapabilities | undefined {
  const engineModule = registry.get(engineId);
  return engineModule?.metadata.capabilities;
}

export function engineSupports(engineId: string, capability: CapabilityKey): boolean {
  const engineModule = registry.get(engineId);
  if (!engineModule || !engineModule.metadata.capabilities) return false;
  const caps = engineModule.metadata.capabilities;
  const value = caps[capability];
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}
