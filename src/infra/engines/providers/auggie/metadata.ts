import type { EngineMetadata } from '../../core/base.js';

export const metadata: EngineMetadata = {
  id: 'auggie',
  name: 'Auggie CLI',
  description: 'Authenticate with Auggie CLI (Augment Code)',
  cliCommand: 'auggie',
  cliBinary: 'auggie',
  installCommand: 'npm install -g @augmentcode/auggie',
  capabilities: {
    resume: true,
    model: true,
    workingDir: true,
    streamLog: true,
    reasoningEffort: false,
    interactiveInput: false,
  },
  order: 6,
};

