/**
 * Workflow Execution Gateway
 *
 * Central execution state pipeline that replaces scattered workflow
 * startup logic across app-shell, runtime, and workflow runner.
 *
 * Pipeline:
 *   IDLE → PREVIEWING → ONBOARDING? → CONFIRMING → EXECUTING → COMPLETED | FAILED
 *
 * Each entry point (TUI, headless, CLI) declares an intent via submit().
 * The gateway drives phase transitions and emits GatewayEvents so the
 * UI layer can react without embedding orchestration logic.
 *
 * Two-phase execute:
 *   1. execute:ready — eventBus + ExecutionContext created, UI must connect adapter
 *   2. proceedWithExecution() — called by UI once adapter is wired up
 *   This ensures no events are missed when the UI adapter connects.
 */

import * as path from 'node:path';
import { debug } from '../../shared/logging/logger.js';
import { setDebugLogFile } from '../../shared/logging/logger.js';
import { WorkflowEventBus } from '../events/event-bus.js';
import { OnboardingService } from '../onboarding/service.js';
import {
  runDryPreview,
  needsOnboarding,
} from '../preflight.js';
import {
  setProjectName,
  setSelectedTrack,
  setSelectedConditions,
  getSelectedTrack,
  getSelectedConditions,
} from '../../shared/workflows/index.js';
import type {
  ExecutionPhase,
  ExecutionIntent,
  PreviewResult,
  OnboardingResult,
  ExecutionContext,
  GatewayEvent,
  GatewayEventListener,
  WorkflowExecutionGateway as IWorkflowExecutionGateway,
  HeadlessExecutionOptions,
} from './types.js';
import type { OnboardingNeeds } from '../preflight.js';
import type { WorkflowTemplate } from '../templates/types.js';

export class DefaultWorkflowExecutionGateway implements IWorkflowExecutionGateway {
  private _phase: ExecutionPhase = 'idle';
  private _eventBus: WorkflowEventBus | null = null;
  private _previewResult: PreviewResult | null = null;
  private _executionContext: ExecutionContext | null = null;
  private _onboardingService: OnboardingService | null = null;
  private _onboardingEventBus: WorkflowEventBus | null = null;
  private _pendingIntent: ExecutionIntent | null = null;
  private _listeners = new Set<GatewayEventListener>();

  get phase(): ExecutionPhase {
    return this._phase;
  }

  get eventBus(): WorkflowEventBus | null {
    return this._eventBus;
  }

  get previewResult(): PreviewResult | null {
    return this._previewResult;
  }

  get executionContext(): ExecutionContext | null {
    return this._executionContext;
  }

  get onboardingService(): OnboardingService | null {
    return this._onboardingService;
  }

  get onboardingEventBus(): WorkflowEventBus | null {
    return this._onboardingEventBus;
  }

  submit(intent: ExecutionIntent): void {
    debug('[Gateway] submit intent=%s cwd=%s', intent.type, intent.cwd);
    if (this._phase !== 'idle') {
      debug('[Gateway] ignoring submit – not idle (phase=%s)', this._phase);
      return;
    }
    this._pendingIntent = intent;
    this.runPreview(intent);
  }

  confirmExecution(): void {
    debug('[Gateway] confirmExecution phase=%s', this._phase);
    if (this._phase !== 'confirming') {
      debug('[Gateway] ignoring confirm – not in confirming phase');
      return;
    }
    this.emit({ type: 'confirm:granted' });
    this.prepareExecute();
  }

  denyExecution(): void {
    debug('[Gateway] denyExecution phase=%s', this._phase);
    if (this._phase !== 'confirming') {
      debug('[Gateway] ignoring deny – not in confirming phase');
      return;
    }
    this.emit({ type: 'confirm:denied' });
    this.transitionTo('idle');
    this._pendingIntent = null;
  }

  proceedWithExecution(): void {
    debug('[Gateway] proceedWithExecution phase=%s', this._phase);
    if (this._phase !== 'executing') {
      debug('[Gateway] ignoring proceed – not in executing phase');
      return;
    }
    this.emit({ type: 'execute:proceeding' });
    this.doExecute();
  }

  completeOnboarding(result: OnboardingResult): void {
    debug('[Gateway] completeOnboarding phase=%s result=%o', this._phase, result);
    if (this._phase !== 'onboarding') {
      debug('[Gateway] ignoring onboarding complete – not in onboarding phase');
      return;
    }

    const intent = this._pendingIntent;
    if (!intent) return;

    const cwd = intent.cwd;
    const cmRoot = path.join(cwd, '.codemachine');

    this.persistOnboardingResult(cmRoot, result).then(() => {
      this.emit({ type: 'onboarding:complete', result });
      this.enterConfirmingPhase();
    }).catch((error: Error) => {
      debug('[Gateway] onboarding persist error: %s', error.message);
      this.fail(error);
    });
  }

  cancelOnboarding(): void {
    debug('[Gateway] cancelOnboarding phase=%s', this._phase);
    if (this._phase !== 'onboarding') return;
    this.emit({ type: 'onboarding:cancelled' });
    this.transitionTo('idle');
    this._pendingIntent = null;
    this._onboardingService = null;
    this._onboardingEventBus = null;
  }

  onEvent(listener: GatewayEventListener): () => void {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  }

  reset(): void {
    debug('[Gateway] reset from phase=%s', this._phase);
    this._phase = 'idle';
    this._eventBus = null;
    this._previewResult = null;
    this._executionContext = null;
    this._onboardingService = null;
    this._onboardingEventBus = null;
    this._pendingIntent = null;
  }

  private transitionTo(phase: ExecutionPhase): void {
    const from = this._phase;
    this._phase = phase;
    debug('[Gateway] phase %s → %s', from, phase);
    this.emit({ type: 'phase:changed', from, to: phase });
  }

  private emit(event: GatewayEvent): void {
    for (const listener of this._listeners) {
      try {
        listener(event);
      } catch (err) {
        debug('[Gateway] listener error: %s', err);
      }
    }
  }

  private enterConfirmingPhase(): void {
    const preview = this._previewResult;
    if (!preview) {
      this.fail(new Error('Preview result missing before confirming'));
      return;
    }
    this.transitionTo('confirming');
    this.emit({ type: 'confirm:required', preview });

    const intent = this._pendingIntent;
    if (intent?.type === 'start-headless' && intent.autoConfirm) {
      debug('[Gateway] headless --yes auto-confirming');
      this.confirmExecution();
    }
  }

  private async runPreview(intent: ExecutionIntent): Promise<void> {
    this.transitionTo('previewing');

    try {
      const result = await runDryPreview({ cwd: intent.cwd });
      this._previewResult = result;

      this.emit({ type: 'preview:complete', result });

      if (intent.type === 'start-dry') {
        debug('[Gateway] dry run – stopping after preview');
        this.transitionTo('completed');
        return;
      }

      if (result.hasErrors) {
        debug('[Gateway] preview has errors, entering confirming phase for review-only');
        this.enterConfirmingPhase();
        return;
      }

      if (result.needsOnboarding) {
        this.startOnboarding(intent, result.onboardingNeeds, result.template);
      } else {
        this.enterConfirmingPhase();
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      debug('[Gateway] preview error: %s', err.message);
      this.emit({ type: 'preview:error', error: err });
      this.fail(err);
    }
  }

  private startOnboarding(
    intent: ExecutionIntent,
    needs: OnboardingNeeds,
    template: WorkflowTemplate,
  ): void {
    this.transitionTo('onboarding');

    const hasTracks = !!(template.tracks && Object.keys(template.tracks.options).length > 0);
    const hasConditionGroups = !!(template.conditionGroups && template.conditionGroups.length > 0);

    const eventBus = new WorkflowEventBus();
    this._onboardingEventBus = eventBus;

    const service = new OnboardingService(eventBus, {
      tracks: hasTracks ? template.tracks : undefined,
      conditionGroups: hasConditionGroups ? template.conditionGroups : undefined,
    });
    this._onboardingService = service;

    this.emit({ type: 'onboarding:required', config: needs, template });
  }

  private async prepareExecute(): Promise<void> {
    this.transitionTo('executing');

    const intent = this._pendingIntent;
    if (!intent) {
      this.fail(new Error('No pending intent for execution'));
      return;
    }

    const cwd = intent.cwd;
    const cmRoot = path.join(cwd, '.codemachine');

    const { getSelectedTrack, getSelectedConditions, setActiveTemplate } = await import('../../shared/workflows/index.js');
    const selectedTrack = await getSelectedTrack(cmRoot);
    const selectedConditions = await getSelectedConditions(cmRoot);

    const preview = this._previewResult;
    if (!preview) {
      this.fail(new Error('Preview result missing before execution'));
      return;
    }

    const templatePath = preview.templatePath;
    const templateFileName = path.basename(templatePath);
    await setActiveTemplate(cmRoot, templateFileName, preview.template.autonomousMode);

    const rawLogLevel = (process.env.LOG_LEVEL || '').trim().toLowerCase();
    const debugFlag = (process.env.DEBUG || '').trim().toLowerCase();
    const debugEnabled = rawLogLevel === 'debug' || (debugFlag !== '' && debugFlag !== '0' && debugFlag !== 'false');
    if (debugEnabled) {
      const debugLogPath = path.join(cwd, '.codemachine', 'logs', 'workflow-debug.log');
      debug('[Gateway] switching to workflow debug log: %s', debugLogPath);
      setDebugLogFile(debugLogPath);
    }

    const eventBus = new WorkflowEventBus();
    this._eventBus = eventBus;
    // @ts-expect-error - global export for workflow connection
    globalThis.__workflowEventBus = eventBus;

    let headlessOptions: HeadlessExecutionOptions | undefined;
    if (intent.type === 'start-headless') {
      headlessOptions = intent.headlessOptions;
    }

    const context: ExecutionContext = {
      cwd,
      cmRoot,
      template: preview.template,
      templatePath,
      templateFileName,
      selectedTrack,
      selectedConditions,
      eventBus,
      headlessOptions,
    };
    this._executionContext = context;

    this.emit({ type: 'execute:ready', eventBus, context });

    if (intent.type === 'start-headless') {
      const { createHeadlessAdapter } = await import('../../cli/tui/routes/workflow/adapters/headless.js');
      const adapter = createHeadlessAdapter({
        logFile: context.headlessOptions?.logFile,
        logLevel: context.headlessOptions?.logLevel,
        timestamps: context.headlessOptions?.timestamps,
      });
      adapter.connect(eventBus);
      adapter.start();
      this.proceedWithExecution();
    }
  }

  private async doExecute(): Promise<void> {
    const context = this._executionContext;
    if (!context) {
      this.fail(new Error('ExecutionContext missing before execution'));
      return;
    }

    debug('[Gateway] executing cwd=%s', context.cwd);

    try {
      const { runWorkflow } = await import('../run.js');
      await runWorkflow(context);
      this.transitionTo('completed');
      this.emit({ type: 'execute:completed' });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      debug('[Gateway] execution failed: %s', err.message);
      this.fail(err);
    }
  }

  private fail(error: Error): void {
    if (this._phase === 'failed') return;
    this.transitionTo('failed');
    this.emit({ type: 'execute:failed', error });
  }

  private async persistOnboardingResult(cmRoot: string, result: OnboardingResult): Promise<void> {
    if (result.projectName) {
      await setProjectName(cmRoot, result.projectName);
    }
    if (result.trackId) {
      await setSelectedTrack(cmRoot, result.trackId);
    }
    if (result.conditions !== undefined) {
      await setSelectedConditions(cmRoot, result.conditions);
    }
  }
}

let _instance: DefaultWorkflowExecutionGateway | null = null;

export function getWorkflowExecutionGateway(): DefaultWorkflowExecutionGateway {
  if (!_instance) {
    _instance = new DefaultWorkflowExecutionGateway();
  }
  return _instance;
}

export function resetWorkflowExecutionGateway(): void {
  if (_instance) {
    _instance.reset();
  }
  _instance = null;
}

export type {
  ExecutionPhase,
  ExecutionIntent,
  PreviewResult,
  OnboardingResult,
  ExecutionContext,
  GatewayEvent,
  HeadlessExecutionOptions,
};
