export interface ProviderModelMeta {
  thinking: 'on' | 'off' | 'toggleable';
  search: boolean;
  modelType: string;
  upstreamModel: string;
}

export const zaiModels: Record<string, ProviderModelMeta> = {
  'GLM-5-Turbo': { upstreamModel: 'GLM-5-Turbo', thinking: 'on', search: true, modelType: 'default' },
  'GLM-5.1': { upstreamModel: 'GLM-5.1', thinking: 'on', search: true, modelType: 'default' },
  'GLM-5v-Turbo': { upstreamModel: 'GLM-5v-Turbo', thinking: 'on', search: true, modelType: 'default' },
  'glm-5': { upstreamModel: 'glm-5', thinking: 'on', search: true, modelType: 'default' },
  'glm-4.7': { upstreamModel: 'glm-4.7', thinking: 'on', search: true, modelType: 'default' },
  'glm-4.6v': { upstreamModel: 'glm-4.6v', thinking: 'on', search: true, modelType: 'default' },
  'glm-4.6': { upstreamModel: 'glm-4.6v', thinking: 'on', search: true, modelType: 'default' },
  'glm-4.5v': { upstreamModel: 'glm-4.5v', thinking: 'on', search: true, modelType: 'default' },
  'glm-4.5-air': { upstreamModel: 'glm-4.5-air', thinking: 'on', search: true, modelType: 'default' },
};

export function getProviderModelMeta(providerModel: string): ProviderModelMeta | undefined {
  return zaiModels[providerModel] ?? zaiModels[findModelKey(providerModel) ?? ''];
}

export function getAllProviderModels(): string[] {
  return Object.keys(zaiModels);
}

export function toZaiUpstreamModel(providerModel: string): string {
  return getProviderModelMeta(providerModel)?.upstreamModel ?? providerModel;
}

export function isZaiProviderModel(providerModel: string): boolean {
  return !!getProviderModelMeta(providerModel);
}

function findModelKey(providerModel: string): string | undefined {
  const lower = providerModel.toLowerCase();
  return Object.keys(zaiModels).find((key) => key.toLowerCase() === lower);
}
