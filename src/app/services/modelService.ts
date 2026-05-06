import { getSetting } from './settingsService';
import { getProviderModelMeta, getAllProviderModels } from '../../providers/deepseek/models';
import type { ProviderModelMeta } from '../../providers/deepseek/models';
import type { ResolvedModel } from '../../types/common';

export type AdapterName = 'openai' | 'anthropic' | 'gemini';

type ModelMap = Record<string, string>;

const SETTING_KEYS: Record<AdapterName, string> = {
  openai: 'model_map_openai',
  anthropic: 'model_map_anthropic',
  gemini: 'model_map_gemini',
};

const DEFAULT_MAPS: Record<AdapterName, ModelMap> = {
  openai: {
    'gpt-4o': 'deepseek-v4-flash',
    'gpt-4o-mini': 'deepseek-v4-flash',
    'gpt-4-turbo': 'deepseek-v4-flash',
    'gpt-3.5-turbo': 'deepseek-v4-flash',
    o1: 'deepseek-v4-pro',
    o3: 'deepseek-v4-pro',
    'o3-mini': 'deepseek-v4-pro',
  },
  anthropic: {
    'claude-sonnet-4-6': 'deepseek-v4-flash',
    'claude-opus-4-6': 'deepseek-v4-pro',
    'claude-3-5-sonnet-20241022': 'deepseek-v4-flash',
    'claude-3-opus-20240229': 'deepseek-v4-pro',
    'claude-3-haiku-20240307': 'deepseek-v4-flash',
  },
  gemini: {
    'gemini-2.5-pro': 'deepseek-v4-pro',
    'gemini-2.5-flash': 'deepseek-v4-flash',
    'gemini-2.0-flash': 'deepseek-v4-flash',
    'gemini-1.5-pro': 'deepseek-v4-pro',
    'gemini-1.5-flash': 'deepseek-v4-flash',
    'gemini-pro': 'deepseek-v4-flash',
  },
};

function getModelMap(adapter: AdapterName): ModelMap {
  const raw = getSetting(SETTING_KEYS[adapter]);
  if (raw) {
    try {
      return JSON.parse(raw) as ModelMap;
    } catch {
      console.warn(`[MODEL] Failed to parse model_map for ${adapter}`);
    }
  }
  return { ...DEFAULT_MAPS[adapter] };
}

export function getModelMapJson(adapter: AdapterName): ModelMap {
  return getModelMap(adapter);
}

export function resolveModel(
  adapter: AdapterName,
  vendorModel: string,
  options?: { thinking?: boolean },
): ResolvedModel {
  const map = getModelMap(adapter);
  let providerModel = map[vendorModel];

  if (!providerModel) {
    const lowerModel = vendorModel.toLowerCase();
    const matchKey = Object.keys(map).find((k) => k.toLowerCase() === lowerModel);
    providerModel = matchKey ? map[matchKey] : 'deepseek-v4-flash';
  }

  const meta: ProviderModelMeta = getProviderModelMeta(providerModel) ?? {
    thinking: 'off',
    search: false,
    modelType: 'default',
  };

  let thinking = meta.thinking === 'on';
  if (meta.thinking === 'toggleable' && options?.thinking !== undefined) {
    thinking = options.thinking;
  }

  return {
    vendorModel,
    providerModel,
    providerName: resolveProviderName(providerModel),
    responseModel: vendorModel,
    thinking,
    search: meta.search,
  };
}

function resolveProviderName(providerModel: string): string {
  if (providerModel.startsWith('deepseek-')) return 'deepseek';
  if (providerModel.startsWith('chatgpt-')) return 'chatgpt';
  return 'deepseek';
}

export function getAvailableProviderModels(): string[] {
  return getAllProviderModels();
}

export function getDefaultMaps(): Record<AdapterName, ModelMap> {
  return { ...DEFAULT_MAPS };
}
