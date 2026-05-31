/**
 * Workflow Execution Gateway Types
 *
 * Defines the execution state pipeline and intent model for workflow startup.
 * All entry points (TUI, headless, CLI) declare intents; the gateway
 * drives the pipeline: preview → onboarding → confirm → execute → completed | failed.
 *
 * Dry preview data (PreviewResult, etc.) is defined in preflight.ts and
 * re-exported here for convenience.
 */

import type { WorkflowEventBus } from '../events/event-bus.js';
import type { OnboardingService } from '../onboarding/service.js';
export type {
  PreviewResult,
  PreviewImport,
  PreviewAgent,
  PreviewChain,
  PreviewBlockingIssue,
  OnboardingNeeds,
} from '../preflight.js';

export type ExecutionPhase =
  | 'idle'
  | 'previewing'
  | 'onboarding'
  | 'confirming'
  | 'executing'
  | 'completed'
  | 'failed';

export type ExecutionIntent =
  | { type: 'start-tui'; cwd: string }
  | { type: 'start-headless'; cwd: string; headlessOptions?: HeadlessExecutionOptions; autoConfirm?: boolean }
  | { type: 'start-dry'; cwd: string };

export interface HeadlessExecutionOptions {
  logFile?: string;
  logLevel?: 'minimal' | 'normal' | 'verbose';
  timestamps?: boolean;
}

export interface OnboardingResult {
  projectName?: string;
  trackId?: string;
  conditions?: string[];
}

export interface ExecutionContext {
  cwd: string;
  cmRoot: string;
  template: import('../templates/types.js').WorkflowTemplate;
  templatePath: string;
  templateFileName: string;
  selectedTrack: string | null;
  selectedConditions: string[] | null;
  eventBus: WorkflowEventBus;
  headlessOptions?: HeadlessExecutionOptions;
}

export type GatewayEvent =
  | { type: 'phase:changed'; from: ExecutionPhase; to: ExecutionPhase }
  | { type: 'preview:complete'; result: PreviewResult }
  | { type: 'preview:error'; error: Error }
  | { type: 'onboarding:required'; config: OnboardingNeeds; template: import('../templates/types.js').WorkflowTemplate }
  | { type: 'onboarding:complete'; result: OnboardingResult }
  | { type: 'onboarding:cancelled' }
  | { type: 'confirm:required'; preview: PreviewResult }
  | { type: 'confirm:granted' }
  | { type: 'confirm:denied' }
  | { type: 'execute:ready'; eventBus: WorkflowEventBus; context: ExecutionContext }
  | { type: 'execute:proceeding' }
  | { type: 'execute:failed'; error: Error }
  | { type: 'execute:completed' };

export type GatewayEventListener = (event: GatewayEvent) => void;

export interface WorkflowExecutionGateway {
  readonly phase: ExecutionPhase;
  readonly eventBus: WorkflowEventBus | null;
  readonly previewResult: PreviewResult | null;
  readonly executionContext: ExecutionContext | null;
  readonly onboardingService: OnboardingService | null;
  readonly onboardingEventBus: WorkflowEventBus | null;

  submit(intent: ExecutionIntent): void;
  confirmExecution(): void;
  denyExecution(): void;
  proceedWithExecution(): void;
  completeOnboarding(result: OnboardingResult): void;
  cancelOnboarding(): void;
  onEvent(listener: GatewayEventListener): () => void;
  reset(): void;
}
