import type { EngineMetadata } from '../../core/base.js';

export const metadata: EngineMetadata = {
  id: 'cursor',
  name: 'Cursor',
  description: 'Authenticate with Cursor AI',
  cliCommand: 'cursor-agent',
  cliBinary: 'cursor-agent',
  installCommand: 'curl https://cursor.com/install -fsS | bash',
  defaultModel: 'auto',
  capabilities: {
    supportsReasoningEffort: false,
    supportsResume: false,
    supportsModelOverride: true,
  },
  order: 4,
  experimental: true,
};
