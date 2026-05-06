export interface ProviderModelMeta {
  thinking: 'on' | 'off' | 'toggleable';
  search: boolean;
  modelType: string;
}

export const deepseekModels: Record<string, ProviderModelMeta> = {
  'deepseek-v4-flash': { thinking: 'toggleable', search: true, modelType: 'default' },
  'deepseek-v4-pro': { thinking: 'toggleable', search: true, modelType: 'expert' },
};

export function getProviderModelMeta(providerModel: string): ProviderModelMeta | undefined {
  return deepseekModels[providerModel];
}

export function getAllProviderModels(): string[] {
  return Object.keys(deepseekModels);
}

export function getModelType(providerModel: string): string {
  return deepseekModels[providerModel]?.modelType ?? 'default';
}
