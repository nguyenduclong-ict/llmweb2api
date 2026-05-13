export interface ProviderModelMeta {
  thinking: 'on' | 'off' | 'toggleable';
  search: boolean;
  modelType: string;
}

export const chatgptModels: Record<string, ProviderModelMeta> = {
  'gpt-5.5': { thinking: 'toggleable', search: false, modelType: 'default' },
  'gpt-5.4': { thinking: 'toggleable', search: false, modelType: 'default' },
  'gpt-auto': { thinking: 'toggleable', search: false, modelType: 'default' },
};

export function getProviderModelMeta(providerModel: string): ProviderModelMeta | undefined {
  return chatgptModels[providerModel];
}

export function getAllProviderModels(): string[] {
  return Object.keys(chatgptModels);
}

export function toChatGptUpstreamModel(providerModel: string, thinking: boolean): string {
  const normalized = providerModel.trim();
  const base =
    normalized === 'gpt-auto' || normalized === 'auto'
      ? 'auto'
      : normalized.replace(/^gpt-(\d+)\.(\d+)$/, 'gpt-$1-$2').replace(/^gpt-(\d+)-(\d+)$/, 'gpt-$1-$2');
  return thinking && !base.endsWith('-thinking') ? `${base}-thinking` : base;
}
