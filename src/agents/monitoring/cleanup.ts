import { AgentMonitorService } from './monitor.js';
import { AgentLoggerService } from './logger.js';
import { StatusService } from './status.js';
import * as logger from '../../shared/logging/logger.js';
import { setShuttingDown } from '../../shared/logging/logger.js';
import { killAllActiveProcesses } from '../../infra/process/spawn.js';

export class MonitoringCleanup {
  private static isSetup = false;
  private static isCleaningUp = false;
  private static firstCtrlCPressed = false;
  private static firstCtrlCTime = 0;
  private static readonly CTRL_C_DEBOUNCE_MS = 500;
  private static readonly EXIT_STATUS_DELAY_MS = 150;
  private static workflowHandlers: {
    onStop?: () => void;
    onExit?: () => void;
    onBeforeCleanup?: () => Promise<void>;
    onBeforeAgentStatusUpdate?: (
      agentId: number,
      finalStatus: 'paused' | 'failed',
      info: { sessionId?: string; monitoringId: number }
    ) => Promise<void>;
  } = {};

  static registerWorkflowHandlers(handlers: {
    onStop?: () => void;
    onExit?: () => void;
    onBeforeCleanup?: () => Promise<void>;
    onBeforeAgentStatusUpdate?: (
      agentId: number,
      finalStatus: 'paused' | 'failed',
      info: { sessionId?: string; monitoringId: number }
    ) => Promise<void>;
  }): void {
    this.workflowHandlers = { ...this.workflowHandlers, ...handlers };
  }

  static clearWorkflowHandlers(): void {
    this.workflowHandlers = {};
  }

  private static resetCtrlCState(): void {
    this.firstCtrlCPressed = false;
    this.firstCtrlCTime = 0;
  }

  private static async stopActiveAgents(): Promise<void> {
    logger.debug('Stopping active agents after first Ctrl+C...');
    killAllActiveProcesses();
    await this.cleanup('aborted', new Error('User interrupted (Ctrl+C)'));
  }

  static setup(): void {
    this.resetCtrlCState();

    if (this.isSetup) {
      return;
    }

    this.isSetup = true;

    process.on('SIGINT', () => {
      void this.handleCtrlCPress('signal');
    });

    process.on('SIGTERM', async () => {
      await this.handleSignal('SIGTERM', 'Process terminated');
    });

    process.on('uncaughtException', async (error: Error) => {
      logger.error('Uncaught exception:', error);
      await this.cleanup('failed', error);
      process.exit(1);
    });

    process.on('unhandledRejection', async (reason: unknown) => {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      logger.error('Unhandled rejection:', error);
      await this.cleanup('failed', error);
      process.exit(1);
    });

    logger.debug('MonitoringCleanup signal handlers initialized');
  }

  static async triggerCtrlCFromUI(): Promise<void> {
    if (!this.isSetup) {
      this.setup();
    }
    await this.handleCtrlCPress('ui');
  }

  private static async handleCtrlCPress(source: 'signal' | 'ui'): Promise<void> {
    if (!this.firstCtrlCPressed) {
      this.firstCtrlCPressed = true;
      this.firstCtrlCTime = Date.now();
      logger.debug(`[${source}] First Ctrl+C detected - showing warning (workflow continues)`);
      this.workflowHandlers.onStop?.();
      return;
    }

    const timeSinceFirst = Date.now() - this.firstCtrlCTime;
    if (timeSinceFirst < this.CTRL_C_DEBOUNCE_MS) {
      logger.debug(
        `[${source}] Ignoring Ctrl+C - too soon (${timeSinceFirst}ms < ${this.CTRL_C_DEBOUNCE_MS}ms). Press Ctrl+C again to exit.`
      );
      return;
    }

    logger.debug(`[${source}] Second Ctrl+C detected after ${timeSinceFirst}ms - stopping workflow and exiting`);

    setShuttingDown(true);

    (process as NodeJS.EventEmitter).emit('workflow:stop');

    await this.stopActiveAgents();

    this.workflowHandlers.onExit?.();

    await new Promise((resolve) => setTimeout(resolve, this.EXIT_STATUS_DELAY_MS));

    await this.handleSignal('SIGINT', 'User interrupted (Ctrl+C)');
  }

  private static async handleSignal(signal: string, message: string): Promise<void> {
    logger.debug(`Received ${signal}: ${message}`);
    setShuttingDown(true);
    logger.debug('Killing all active child processes...');
    killAllActiveProcesses();
    await this.cleanup('aborted', new Error(message));
    if (process.stdout.isTTY) {
      process.stdout.write('\x1b[?2004l');
      process.stdout.write('\x1b[<u');
      process.stdout.write('\x1b[2J\x1b[H\x1b[?25h');
    }
    process.exit(130);
  }

  private static async cleanup(reason: 'failed' | 'aborted', error?: Error): Promise<void> {
    if (this.isCleaningUp) {
      return;
    }

    this.isCleaningUp = true;

    try {
      if (this.workflowHandlers.onBeforeCleanup) {
        try {
          await this.workflowHandlers.onBeforeCleanup();
        } catch (err) {
          logger.debug('onBeforeCleanup failed:', err);
        }
      }

      const monitor = AgentMonitorService.getInstance();
      const loggerService = AgentLoggerService.getInstance();
      const status = StatusService.getInstance();

      const runningAgents = monitor.getActiveAgents();

      if (runningAgents.length > 0) {
        logger.debug(`Cleaning up ${runningAgents.length} running agent(s)...`);

        for (const agent of runningAgents) {
          try {
            if (status.isSkipped(agent.id)) {
              continue;
            }
            const dbAgent = monitor.getAgent(agent.id);
            if (dbAgent?.status === 'paused') {
              continue;
            }

            const finalStatus: 'paused' | 'failed' = dbAgent?.sessionId ? 'paused' : 'failed';
            const errorMsg = error || new Error(`Agent ${reason}: ${agent.name}`);

            if (this.workflowHandlers.onBeforeAgentStatusUpdate) {
              try {
                await this.workflowHandlers.onBeforeAgentStatusUpdate(
                  agent.id,
                  finalStatus,
                  { sessionId: dbAgent?.sessionId, monitoringId: agent.id }
                );
              } catch (handlerError) {
                logger.debug('onBeforeAgentStatusUpdate failed for agent %d:', agent.id, handlerError);
              }
            }

            if (finalStatus === 'paused') {
              await status.pause(agent.id);
            } else {
              await status.fail(agent.id, errorMsg);
            }

            await loggerService.closeStream(agent.id);
          } catch (cleanupError) {
            logger.error(`Failed to cleanup agent ${agent.id}:`, cleanupError);
          }
        }

        await loggerService.releaseAllLocks();

        logger.debug('Cleanup complete');
      }
    } catch (error) {
      logger.error('Error during cleanup:', error);
    } finally {
      this.isCleaningUp = false;
    }
  }

  static async forceCleanup(): Promise<void> {
    await this.cleanup('failed', new Error('Manual cleanup'));
  }
}
