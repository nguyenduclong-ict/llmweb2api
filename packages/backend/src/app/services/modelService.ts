import { getSetting } from './settingsService';
import {
  getProviderModelMeta as getDeepSeekModelMeta,
  getAllProviderModels as getAllDeepSeekModels,
} from '../../providers/deepseek/models';
import {
  getProviderModelMeta as getQwenModelMeta,
  getAllProviderModels as getAllQwenModels,
} from '../../providers/qwen/models';
import {
  getProviderModelMeta as getChatGptModelMeta,
  getAllProviderModels as getAllChatGptModels,
} from '../../providers/chatgpt/models';
import type { ProviderModelMeta } from '../../providers/deepseek/models';
import type { ResolvedModel, ThinkingLevel } from '../../types/common';

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
  options?: { thinking?: boolean; thinkingLevel?: ThinkingLevel },
): ResolvedModel;
export function resolveModel(
  adapter: AdapterName,
  vendorModel: string,
  thinking?: boolean,
  thinkingLevel?: ThinkingLevel,
): ResolvedModel;
export function resolveModel(
  adapter: AdapterName,
  vendorModel: string,
  arg3?: boolean | { thinking?: boolean; thinkingLevel?: ThinkingLevel },
  arg4?: ThinkingLevel,
): ResolvedModel {
  let thinkingOverride: boolean | undefined;
  let thinkingLevelOverride: ThinkingLevel | undefined;

  if (typeof arg3 === 'object' && arg3 !== null) {
    thinkingOverride = arg3.thinking;
    thinkingLevelOverride = arg3.thinkingLevel;
  } else {
    thinkingOverride = arg3;
    thinkingLevelOverride = arg4;
  }
  const map = getModelMap(adapter);
  let providerModel = map[vendorModel];

  if (!providerModel) {
    const lowerModel = vendorModel.toLowerCase();
    const matchKey = Object.keys(map).find((k) => k.toLowerCase() === lowerModel);
    if (matchKey) {
      providerModel = map[matchKey];
    } else if (getDeepSeekModelMeta(vendorModel) || getQwenModelMeta(vendorModel) || getChatGptModelMeta(vendorModel)) {
      providerModel = vendorModel;
    } else {
      providerModel = 'deepseek-v4-flash';
    }
  }

  const meta: ProviderModelMeta = getDeepSeekModelMeta(providerModel) ??
    getQwenModelMeta(providerModel) ??
    getChatGptModelMeta(providerModel) ?? {
      thinking: 'off',
      search: false,
      modelType: 'default',
    };

  let thinking = meta.thinking === 'on' || meta.thinking === 'toggleable';
  if (meta.thinking === 'toggleable' && thinkingOverride === undefined && isChatGptProviderModel(providerModel)) {
    thinking = false;
  }
  if (meta.thinking === 'toggleable' && thinkingOverride === false) {
    thinking = false;
  }
  if (meta.thinking === 'toggleable' && thinkingOverride === true) {
    thinking = true;
  }

  return {
    vendorModel,
    providerModel,
    providerName: resolveProviderName(providerModel),
    responseModel: vendorModel,
    thinking,
    search: meta.search,
    thinkingLevel: thinkingLevelOverride,
  };
}

function resolveProviderName(providerModel: string): string {
  if (providerModel.startsWith('deepseek-')) return 'deepseek';
  if (isChatGptProviderModel(providerModel)) return 'chatgpt';
  if (providerModel.startsWith('qwen')) return 'qwen';
  return 'deepseek';
}

function isChatGptProviderModel(providerModel: string): boolean {
  return !!getChatGptModelMeta(providerModel);
}

export function getAvailableProviderModels(): string[] {
  return [...getAllDeepSeekModels(), ...getAllQwenModels(), ...getAllChatGptModels()];
}

export function getDefaultMaps(): Record<AdapterName, ModelMap> {
  return { ...DEFAULT_MAPS };
}
