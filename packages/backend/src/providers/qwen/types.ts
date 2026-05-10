export const QWEN_BASE_URL = 'https://chat.qwen.ai';

export const QWEN_API_URLS = {
  chatsNew: `${QWEN_BASE_URL}/api/v2/chats/new`,
  chatCompletions: `${QWEN_BASE_URL}/api/v2/chat/completions`,
  chatCompletionsStop: `${QWEN_BASE_URL}/api/v2/chat/completions/stop`,
};

export const FILE_UPLOAD_THRESHOLD = 100 * 1024;

export const BAXIA_VERSION = '2.5.36';

export const CACHE_TTL = 4 * 60 * 1000;

export const WEB_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

export interface BaxiaTokens {
  bxUa: string;
  bxUmidToken: string;
  bxV: string;
}

export interface CreateChatResponse {
  success: boolean;
  data?: {
    id: string;
  };
  msg?: string;
}

export interface QwenCompletionPayload {
  stream: boolean;
  version: string;
  incremental_output: boolean;
  chat_id: string;
  chat_mode: string;
  model: string;
  parent_id: string | null;
  messages: QwenMessagePayload[];
  timestamp: number;
}

export interface QwenMessagePayload {
  fid: string;
  parentId: string | null;
  childrenIds: string[];
  role: 'user';
  content: string;
  user_action: string;
  files: unknown[];
  timestamp: number;
  models: string[];
  chat_type: string;
  feature_config: QwenFeatureConfig;
  extra: { meta: { subChatType: string } };
  sub_chat_type: string;
  parent_id: string | null;
}

export interface QwenFeatureConfig {
  thinking_enabled: boolean;
  output_schema: string;
  research_mode: string;
  auto_thinking: boolean;
  thinking_mode: string;
  thinking_format: string;
  auto_search: boolean;
  function_calling?: boolean;
  enable_tools?: boolean;
  tool_choice?: string;
}

export interface UploadFileInfo {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface StsTokenData {
  file_url: string;
  file_id?: string;
  access_key_id: string;
  access_key_secret: string;
  security_token: string;
}

export interface StsTokenResponse {
  success: boolean;
  data?: StsTokenData;
  msg?: string;
}

export interface QwenFilePayload {
  type: string;
  file: {
    created_at: number;
    data: Record<string, unknown>;
    filename: string;
    hash: null;
    id: string;
    meta: {
      name: string;
      size: number;
      content_type: string;
    };
    update_at: number;
  };
  id: string;
  url: string;
  name: string;
  collection_name: string;
  progress: number;
  status: string;
  is_uploading: boolean;
  error: string;
  showType: string;
  file_class: string;
  itemId: string;
  greenNet: string;
  size: number;
  file_type: string;
  uploadTaskId: string;
}

export const QWEN_BASE_HEADERS: Record<string, string> = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Content-Type': 'application/json',
  'sec-ch-ua': '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': WEB_USER_AGENT,
  source: 'web',
};
