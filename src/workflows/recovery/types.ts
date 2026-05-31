/**
 * Crash Recovery Types
 *
 * Types specific to crash recovery operations.
 */

import type { StepData, ResumeDecision, ResumeInfo } from '../indexing/types.js';
import type { WorkflowEventEmitter } from '../events/index.js';
import type { StepIndexManager } from '../indexing/index.js';
import type { WorkflowContext } from '../state/types.js';
import type { ModuleStep, WorkflowTemplate } from '../templates/types.js';
import type { StepSession } from '../session/index.js';
import type { AgentStatus } from '../../agents/monitoring/types.js';

/**
 * Result of crash recovery detection
 */
export interface CrashDetectionResult {
  /** Whether this step is resuming from a crash */
  isRecovering: boolean;
  /** Session ID to resume (if recovering) */
  sessionId?: string;
  /** Monitoring ID to resume (if recovering) */
  monitoringId?: number;
  /** Completed chain indices (if any) */
  completedChains?: number[];
}

/**
 * Context needed for crash recovery restoration
 */
export interface CrashRestoreContext {
  /** Step data containing session info */
  stepData: StepData;
  /** Current step definition */
  step: ModuleStep;
  /** Step index */
  stepIndex: number;
  /** Unique agent ID for this step */
  uniqueAgentId: string;
  /** Working directory */
  cwd: string;
  /** .codemachine root directory */
  cmRoot: string;
  /** Event emitter for UI updates */
  emitter: WorkflowEventEmitter;
  /** State machine context */
  machineContext: WorkflowContext;
  /** Index manager for queue operations */
  indexManager: StepIndexManager;
  /** Current step session (optional) */
  session?: StepSession | null;
}

/**
 * Result of crash recovery restoration
 */
export interface CrashRestoreResult {
  /** Whether restoration was successful */
  success: boolean;
  /** Queue was restored with chained prompts */
  queueRestored: boolean;
  /** Number of prompts in restored queue */
  promptCount: number;
  /** Resume index in the queue */
  resumeIndex: number;
}

/**
 * Chained prompt status for recovery plan
 */
export interface RecoveryChainStatus {
  /** Chain index */
  index: number;
  /** Chain name */
  name: string;
  /** Chain label/description */
  label: string;
  /** Whether this chain is completed */
  completed: boolean;
  /** Whether this chain is the next to resume */
  isNext: boolean;
}

/**
 * Step recovery status enum
 */
export enum StepRecoveryStatus {
  /** Step is fully completed */
  COMPLETED = 'completed',
  /** Step can be resumed (has valid session) */
  RESUMABLE = 'resumable',
  /** Step started but session is invalid (can only mark as failed) */
  FAILED = 'failed',
  /** Step has not started yet */
  NOT_STARTED = 'not_started',
  /** Step is excluded by track/conditions */
  EXCLUDED = 'excluded',
}

/**
 * Step recovery information for recovery plan
 */
export interface RecoveryStepInfo {
  /** Step index (module step index) */
  stepIndex: number;
  /** Original step index in template (includes separators) */
  templateIndex: number;
  /** Agent ID */
  agentId: string;
  /** Agent name */
  agentName: string;
  /** Step recovery status */
  status: StepRecoveryStatus;
  /** Session ID (if available) */
  sessionId?: string;
  /** Monitoring ID (if available) */
  monitoringId?: number;
  /** Agent status from monitoring DB */
  agentStatus?: AgentStatus;
  /** Chained prompts status */
  chains?: RecoveryChainStatus[];
  /** Next chain index to resume (if resumable) */
  nextChainIndex?: number;
  /** Total number of chained prompts */
  totalChains?: number;
  /** Error message if status is FAILED */
  error?: string;
}

/**
 * Options for generating a recovery plan
 */
export interface GenerateRecoveryPlanOptions {
  /** Workflow template */
  template: WorkflowTemplate;
  /** Module steps (filtered by track/conditions) */
  moduleSteps: ModuleStep[];
  /** Visible steps (including separators) */
  visibleSteps: Array<{ step: ModuleStep | { type: string; text?: string }; templateIndex: number }>;
  /** Resume info from step index */
  resumeInfo: ResumeInfo;
  /** Map of step index to step data */
  stepDataMap: Map<number, StepData | null>;
  /** Working directory */
  cwd: string;
  /** .codemachine root directory */
  cmRoot: string;
}

/**
 * Complete recovery plan for a workflow session
 * This is the single source of truth for all recovery-related information
 */
export interface RecoveryPlan {
  /** Whether this session needs recovery */
  needsRecovery: boolean;
  /** Resume decision type */
  resumeDecision: ResumeDecision;
  /** Step index to start/resume from */
  startIndex: number;
  /** Total number of steps in workflow */
  totalSteps: number;
  /** Number of completed steps */
  completedSteps: number;
  /** Number of resumable steps */
  resumableSteps: number;
  /** Number of failed steps */
  failedSteps: number;
  /** Number of not started steps */
  notStartedSteps: number;
  /** Detailed recovery info for each step */
  steps: RecoveryStepInfo[];
  /** Summary message for display */
  summary: string;
  /** Whether user confirmation is required before resuming */
  requiresConfirmation: boolean;
}
