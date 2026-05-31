import type { Command } from 'commander';
import { MonitoringCleanup } from '../../agents/monitoring/index.js';
import {
  getWorkflowExecutionGateway,
  resetWorkflowExecutionGateway,
} from '../../workflows/gateway/index.js';
import type {
  ExecutionIntent,
  HeadlessExecutionOptions,
} from '../../workflows/gateway/types.js';
import chalk from 'chalk';

type WorkflowCommandOptions = {
  headless?: boolean;
  yes?: boolean;
  logFile?: string;
  logLevel?: 'minimal' | 'normal' | 'verbose';
  timestamps?: boolean;
  dir: string;
};

export async function registerWorkflowCommand(program: Command): Promise<void> {
  program
    .command('workflow')
    .description('Run a workflow pipeline with preflight checks and onboarding')
    .option('--headless', 'Run without TUI (CI/automation mode)')
    .option('-y, --yes', 'Skip confirmation prompt (only with --headless)')
    .option('--log-file <path>', 'Path for headless log output')
    .option('--log-level <level>', 'Headless log level: minimal, normal, verbose', 'normal')
    .option('--no-timestamps', 'Disable timestamps in headless logs')
    .option('-d, --dir <directory>', 'Working directory', process.cwd())
    .action(async (options: WorkflowCommandOptions) => {
      const cwd = options.dir;
      process.env.CODEMACHINE_CWD = cwd;

      if (options.headless) {
        await runHeadlessWorkflow(cwd, {
          logFile: options.logFile,
          logLevel: options.logLevel as 'minimal' | 'normal' | 'verbose',
          timestamps: options.timestamps ?? true,
        }, options.yes ?? false);
      } else {
        await runTUIWorkflow(cwd);
      }
    });
}

function printPreview(result: import('../../workflows/gateway/types.js').PreviewResult): void {
  const { template, templatePath, specPath, imports, agents, subAgents, chains, blockingIssues, hasErrors } = result;
  const moduleSteps = agents.length;
  const errors = blockingIssues.filter(i => i.type === 'error');
  const warnings = blockingIssues.filter(i => i.type === 'warning');

  console.log('');
  console.log(chalk.bold(`  Workflow: ${template.name}`));
  console.log(chalk.dim(`  Template: ${templatePath}`));
  if (specPath) {
    console.log(chalk.dim(`  Spec:     ${specPath}`));
  }
  console.log('');

  if (imports.length > 0) {
    console.log(chalk.bold(`  Imports (${imports.length})`));
    for (const imp of imports) {
      console.log(chalk.dim(`    ${imp.name}@${imp.version} (${imp.source})`));
    }
    console.log('');
  }

  if (subAgents.length > 0) {
    console.log(chalk.bold(`  Sub-agents (${subAgents.length})`));
    console.log(chalk.dim(`    ${subAgents.join(', ')}`));
    console.log('');
  }

  console.log(chalk.bold(`  Agents (${moduleSteps})`));
  for (const agent of agents) {
    const tagInteractive = agent.isInteractive ? ' [interactive]' : '';
    const tagBehavior = agent.moduleBehavior ? ` [${agent.moduleBehavior}]` : '';
    const modelEffort = agent.modelReasoningEffort ? ` (effort:${agent.modelReasoningEffort})` : '';
    console.log(`    ${agent.agentName}`);
    console.log(chalk.dim(`      engine=${agent.engine}, model=${agent.model}${modelEffort}`));
    console.log(chalk.dim(`      prompts: ${agent.promptPath.join(', ')}`));
    if (agent.tracks?.length) {
      console.log(chalk.dim(`      tracks:  ${agent.tracks.join(', ')}`));
    }
    if (agent.conditions?.length || agent.conditionsAny?.length) {
      const conds = [...(agent.conditions || []), ...(agent.conditionsAny || [])].join(', ');
      console.log(chalk.dim(`      conds:   ${conds}`));
    }
    if (tagInteractive || tagBehavior) {
      console.log(chalk.dim(`      ${tagInteractive}${tagBehavior}`.trim()));
    }
  }
  console.log('');

  if (chains.length > 0) {
    console.log(chalk.bold(`  Trigger Chains (${chains.length})`));
    for (const chain of chains) {
      console.log(chalk.dim(`    ${chain.name}`));
    }
    console.log('');
  }

  if (errors.length > 0 || warnings.length > 0) {
    console.log(chalk.bold(`  Issues (${errors.length} errors, ${warnings.length} warnings)`));
    for (const issue of blockingIssues) {
      const prefix = issue.type === 'error' ? '  ✗ ' : '  ⚠ ';
      const color = issue.type === 'error' ? 'red' : 'yellow';
      const stepInfo = issue.agentId ? ` (${issue.agentId})` : '';
      console.log(chalk[color](`${prefix}${issue.message}${stepInfo}`));
    }
    console.log('');
  }

  if (hasErrors) {
    console.log(chalk.red('  BLOCKED: Errors must be fixed before proceeding'));
    console.log('');
  }
}

async function runHeadlessWorkflow(
  cwd: string,
  headlessOptions: HeadlessExecutionOptions,
  autoConfirm: boolean,
): Promise<void> {
  MonitoringCleanup.setup();

  const gateway = getWorkflowExecutionGateway();

  try {
    const exitCode = await new Promise<number>((resolve) => {
      gateway.onEvent((event) => {
        switch (event.type) {
          case 'preview:error':
            console.error(chalk.red(`\nPreflight failed: ${event.error.message}\n`));
            resolve(1);
            break;
          case 'onboarding:required':
            console.error(chalk.yellow('\nOnboarding required but not available in headless mode.'));
            console.error(chalk.yellow('Run without --headless to complete onboarding.\n'));
            resolve(1);
            break;
          case 'confirm:required': {
            printPreview(event.preview);
            if (event.preview.hasErrors) {
              console.error(chalk.red('  Errors detected. Cannot proceed with --yes flag.'));
              gateway.denyExecution();
              resolve(1);
            } else if (autoConfirm) {
              console.log(chalk.dim('  --yes flag set, proceeding...\n'));
              gateway.confirmExecution();
            } else {
              console.error(chalk.yellow('  Confirmation required. Use --yes to auto-confirm.\n'));
              gateway.denyExecution();
              resolve(1);
            }
            break;
          }
          case 'execute:failed':
            console.error(chalk.red(`\nWorkflow failed: ${event.error.message}\n`));
            resolve(1);
            break;
          case 'execute:completed':
            console.log(chalk.green('\nWorkflow completed successfully\n'));
            resolve(0);
            break;
        }
      });

      const intent: ExecutionIntent = {
        type: 'start-headless',
        cwd,
        headlessOptions,
        autoConfirm,
      };
      gateway.submit(intent);
    });

    resetWorkflowExecutionGateway();
    process.exit(exitCode);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`\nExecution failed: ${message}\n`));
    resetWorkflowExecutionGateway();
    process.exit(1);
  }
}

async function runTUIWorkflow(cwd: string): Promise<void> {
  const gateway = getWorkflowExecutionGateway();
  const intent: ExecutionIntent = { type: 'start-tui', cwd };
  gateway.submit(intent);
}
