import type { EngineMetadata } from '../../core/base.js';

export const metadata: EngineMetadata = {
  id: 'claude',
  name: 'Claude Code',
  description: 'Authenticate with Claude AI',
  cliCommand: 'claude',
  cliBinary: 'claude',
  installCommand: 'npm install -g @anthropic-ai/claude-code',
  defaultModel: 'opus',
  capabilities: {
    supportsReasoningEffort: false,
    supportsResume: true,
    supportsModelOverride: true,
    supportedModels: ['opus', 'sonnet', 'haiku'],
  },
  order: 2,
  experimental: true,
};
