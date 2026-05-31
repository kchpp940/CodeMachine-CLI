export type ModelSupportMode = 'supported' | 'ignored' | 'required';

export interface ProviderCommandOptions {
  workingDir: string;
  resumeSessionId?: string;
  resumePrompt?: string;
  model?: string;
  modelReasoningEffort?: 'low' | 'medium' | 'high';
}

export interface ProviderCommand {
  command: string;
  args: string[];
}

export interface ModelValidationResult {
  isValid: boolean;
  mappedModel?: string;
  error?: string;
}

export interface ModelMappingConfig {
  modelMap: Record<string, string>;
  validModels: string[];
  providerName: string;
  modelSupport: ModelSupportMode;
}

export function validateAndMapModel(
  model: string | undefined,
  config: ModelMappingConfig,
  isResume: boolean,
): ModelValidationResult {
  switch (config.modelSupport) {
    case 'ignored':
      if (model?.trim()) {
        return {
          isValid: false,
          error: `${config.providerName} does not support configured model '${model.trim()}'. Remove the model setting from your engine configuration or use a different engine that supports model selection.`,
        };
      }
      return { isValid: true };
    case 'required':
      if (!model) {
        return {
          isValid: false,
          error: `${config.providerName} requires a model to be specified.`,
        };
      }
      break;
    case 'supported':
    default:
      if (!model) {
        return { isValid: true };
      }
      break;
  }

  const trimmedModel = model.trim();

  if (config.validModels.length === 0 && Object.keys(config.modelMap).length === 0) {
    return {
      isValid: true,
      mappedModel: trimmedModel,
    };
  }

  if (trimmedModel in config.modelMap) {
    return {
      isValid: true,
      mappedModel: config.modelMap[trimmedModel],
    };
  }

  if (config.validModels.includes(trimmedModel)) {
    return {
      isValid: true,
      mappedModel: trimmedModel,
    };
  }

  return {
    isValid: false,
    error: `Invalid model '${trimmedModel}' for ${config.providerName}. Valid models: ${config.validModels.join(', ')}, or use mapped aliases: ${Object.keys(config.modelMap).join(', ')}`,
  };
}

export function validateResumeParams(
  resumeSessionId: string | undefined,
  resumePrompt: string | undefined,
  providerName: string,
): { isValid: boolean; error?: string; validatedPrompt: string } {
  if (resumeSessionId) {
    if (!resumePrompt || !resumePrompt.trim()) {
      return {
        isValid: false,
        error: `${providerName} resume requires a non-empty resumePrompt when resumeSessionId is provided`,
        validatedPrompt: '',
      };
    }
    return { isValid: true, validatedPrompt: resumePrompt.trim() };
  }
  return { isValid: true, validatedPrompt: '' };
}

export function validateWorkingDir(
  workingDir: string,
  providerName: string,
): { isValid: boolean; error?: string } {
  if (!workingDir || !workingDir.trim()) {
    return {
      isValid: false,
      error: `${providerName} requires a non-empty working directory`,
    };
  }
  return { isValid: true };
}

export function validateAllOptions(
  options: ProviderCommandOptions,
  modelConfig: ModelMappingConfig,
): {
  isValid: boolean;
  error?: string;
  mappedModel?: string;
  validatedResumePrompt?: string;
  isResume: boolean;
} {
  const isResume = !!options.resumeSessionId;

  const workingDirResult = validateWorkingDir(options.workingDir, modelConfig.providerName);
  if (!workingDirResult.isValid) {
    return { isValid: false, error: workingDirResult.error, isResume };
  }

  const resumeResult = validateResumeParams(
    options.resumeSessionId,
    options.resumePrompt,
    modelConfig.providerName,
  );
  if (!resumeResult.isValid) {
    return { isValid: false, error: resumeResult.error, isResume };
  }

  const modelResult = validateAndMapModel(options.model, modelConfig, isResume);
  if (!modelResult.isValid) {
    return { isValid: false, error: modelResult.error, isResume };
  }

  return {
    isValid: true,
    mappedModel: modelResult.mappedModel,
    validatedResumePrompt: resumeResult.validatedPrompt,
    isResume,
  };
}
