export interface ProviderModelMeta {
  thinking: 'on' | 'off' | 'toggleable';
  search: boolean;
  modelType: string;
}

export const qwenModels: Record<string, ProviderModelMeta> = {
  'qwen3.6-plus': { thinking: 'toggleable', search: true, modelType: 'default' },
  'qwen3.6-max-preview': { thinking: 'toggleable', search: true, modelType: 'expert' },
  'qwen-3.5-plus': { thinking: 'toggleable', search: true, modelType: 'default' },
  'qwen-3.5-flash': { thinking: 'off', search: true, modelType: 'default' },
  'qwen-3.5-turbo': { thinking: 'off', search: true, modelType: 'default' },
};

export function getProviderModelMeta(providerModel: string): ProviderModelMeta | undefined {
  return qwenModels[providerModel];
}

export function getAllProviderModels(): string[] {
  return Object.keys(qwenModels);
}

export function getModelType(providerModel: string): string {
  return qwenModels[providerModel]?.modelType ?? 'default';
}
