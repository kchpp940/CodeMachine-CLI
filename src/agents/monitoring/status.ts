import { AgentMonitorService } from './monitor.js';
import { AgentLoggerService } from './logger.js';
import type { AgentStatus } from './types.js';
import type { WorkflowEventEmitter } from '../../workflows/events/emitter.js';
import type { ParsedTelemetry } from '../../shared/telemetry/index.js';
import { debug } from '../../shared/logging/logger.js';

type PersistentStatus = 'running' | 'paused' | 'completed' | 'failed' | 'skipped';
type EphemeralStatus = 'awaiting' | 'delegated' | 'pending' | 'retrying';

const LEGAL_TRANSITIONS: Record<PersistentStatus, Set<PersistentStatus>> = {
  running: new Set(['paused', 'completed', 'failed', 'skipped']),
  paused: new Set(['running', 'failed']),
  completed: new Set([]),
  failed: new Set([]),
  skipped: new Set([]),
};

export class IllegalTransitionError extends Error {
  readonly from: PersistentStatus;
  readonly to: PersistentStatus;
  readonly agentId: number;

  constructor(from: PersistentStatus, to: PersistentStatus, agentId: number) {
    super(`Illegal state transition ${from}→${to} for agent ${agentId}`);
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.to = to;
    this.agentId = agentId;
  }
}

export class StatusService {
  private static instance: StatusService;
  private readonly monitor: AgentMonitorService;
  private emitter: WorkflowEventEmitter | null = null;
  private idMap = new Map<number, string>();
  private skippedIds = new Set<number>();
  private dbStatusCache = new Map<number, PersistentStatus>();

  private constructor() {
    this.monitor = AgentMonitorService.getInstance();
  }

  static getInstance(): StatusService {
    if (!StatusService.instance) {
      StatusService.instance = new StatusService();
    }
    return StatusService.instance;
  }

  setEmitter(emitter: WorkflowEventEmitter): void {
    this.emitter = emitter;
  }

  register(monitoringId: number, uniqueAgentId: string): void {
    this.idMap.set(monitoringId, uniqueAgentId);
  }

  getAgentId(monitoringId: number): string | undefined {
    return this.idMap.get(monitoringId);
  }

  getMonitoringId(uniqueAgentId: string): number | undefined {
    for (const [monitoringId, agentId] of this.idMap.entries()) {
      if (agentId === uniqueAgentId) {
        return monitoringId;
      }
    }
    return undefined;
  }

  clear(monitoringId: number): void {
    this.idMap.delete(monitoringId);
    this.skippedIds.delete(monitoringId);
    this.dbStatusCache.delete(monitoringId);
  }

  isSkipped(monitoringId: number): boolean {
    return this.skippedIds.has(monitoringId);
  }

  private isValidTransition(from: PersistentStatus, to: PersistentStatus): boolean {
    if (from === to) return false;
    return LEGAL_TRANSITIONS[from]?.has(to) ?? false;
  }

  private cacheStatus(id: number, status: PersistentStatus): void {
    this.dbStatusCache.set(id, status);
  }

  private getCachedStatus(id: number): PersistentStatus | undefined {
    return this.dbStatusCache.get(id);
  }

  private loadDbStatus(id: number): PersistentStatus | undefined {
    const agent = this.monitor.getAgent(id);
    if (agent?.status) {
      const s = agent.status as PersistentStatus;
      this.dbStatusCache.set(id, s);
      return s;
    }
    return undefined;
  }

  private getEffectiveStatus(id: number): PersistentStatus | undefined {
    return this.getCachedStatus(id) ?? this.loadDbStatus(id);
  }

  async markSkipped(monitoringId: number): Promise<void> {
    this.skippedIds.add(monitoringId);
    await AgentLoggerService.getInstance().flush(monitoringId);
    await this.monitor.markSkipped(monitoringId);
    this.cacheStatus(monitoringId, 'skipped');
    this.emitStatus(monitoringId, 'skipped');
  }

  async complete(id: number, telemetry?: ParsedTelemetry): Promise<void> {
    const current = this.getEffectiveStatus(id);
    if (current && !this.isValidTransition(current, 'completed')) {
      throw new IllegalTransitionError(current, 'completed', id);
    }
    await AgentLoggerService.getInstance().flush(id);
    await this.monitor.complete(id, telemetry);
    this.cacheStatus(id, 'completed');
    this.emitStatus(id, 'completed');
  }

  async fail(id: number, error: Error | string): Promise<void> {
    const current = this.getEffectiveStatus(id);
    if (current && !this.isValidTransition(current, 'failed')) {
      throw new IllegalTransitionError(current, 'failed', id);
    }
    await AgentLoggerService.getInstance().flush(id);
    await this.monitor.fail(id, error);
    this.cacheStatus(id, 'failed');
    this.emitStatus(id, 'failed');
  }

  async pause(id: number): Promise<void> {
    const current = this.getEffectiveStatus(id);
    if (current && !this.isValidTransition(current, 'paused')) {
      throw new IllegalTransitionError(current, 'paused', id);
    }
    await AgentLoggerService.getInstance().flush(id);
    await this.monitor.markPaused(id);
    this.cacheStatus(id, 'paused');
    this.emitStatus(id, 'paused');
  }

  async run(id: number): Promise<void> {
    const current = this.getEffectiveStatus(id);
    if (current && !this.isValidTransition(current, 'running')) {
      throw new IllegalTransitionError(current, 'running', id);
    }
    await this.monitor.markRunning(id);
    this.cacheStatus(id, 'running');
    this.emitStatus(id, 'running');
  }

  async handleAbort(id: number, error?: Error): Promise<void> {
    if (this.isSkipped(id)) {
      return;
    }
    const agent = this.monitor.getAgent(id);
    if (agent?.status === 'paused') {
      return;
    }
    try {
      if (agent?.sessionId) {
        await this.pause(id);
      } else {
        await this.fail(id, error ?? new Error('Aborted'));
      }
    } catch (e) {
      if (e instanceof IllegalTransitionError) {
        debug('[StatusService] handleAbort: agent %d already in terminal state %s, cannot transition to %s',
          id, e.from, e.to);
        return;
      }
      throw e;
    }
  }

  awaiting(agentId: string): void {
    this.emitter?.updateAgentStatus(agentId, 'awaiting');
  }

  delegated(agentId: string): void {
    this.emitter?.updateAgentStatus(agentId, 'delegated');
  }

  pending(agentId: string): void {
    this.emitter?.updateAgentStatus(agentId, 'pending');
  }

  skipped(agentId: string): void {
    this.emitter?.updateAgentStatus(agentId, 'skipped');
  }

  retrying(agentId: string): void {
    this.emitter?.updateAgentStatus(agentId, 'retrying');
  }

  running(agentId: string): void {
    this.emitter?.updateAgentStatus(agentId, 'running');
  }

  completed(agentId: string): void {
    this.emitter?.updateAgentStatus(agentId, 'completed');
  }

  failed(agentId: string): void {
    this.emitter?.updateAgentStatus(agentId, 'failed');
  }

  emitStatus(id: number, status: string): void {
    const agentId = this.idMap.get(id);
    if (agentId) {
      this.emitter?.updateAgentStatus(agentId, status as AgentStatus);
    }
  }

  getDbStatus(id: number): PersistentStatus | undefined {
    return this.getEffectiveStatus(id);
  }
}
