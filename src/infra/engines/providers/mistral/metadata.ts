import type { EngineMetadata } from '../../core/base.js';

export const metadata: EngineMetadata = {
  id: 'mistral',
  name: 'Mistral Vibe',
  description: 'Authenticate with Mistral AI',
  cliCommand: 'vibe',
  cliBinary: 'vibe',
  installCommand: 'uv tool install mistral-vibe',
  defaultModel: 'devstral-2',
  capabilities: {
    resume: true,
    model: false,
    workingDir: true,
    streamLog: true,
    reasoningEffort: false,
    interactiveInput: true,
  },
  order: 5,
  experimental: true,
};

