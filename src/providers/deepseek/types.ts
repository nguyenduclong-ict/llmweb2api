export interface DeepSeekLoginPayload {
  email?: string;
  password: string;
  device_id: string;
  os: string;
}

export interface DeepSeekLoginResponse {
  code: number;
  msg: string;
  data: {
    biz_code: number;
    biz_msg: string;
    biz_data: {
      user: {
        token: string;
      };
    };
  };
}

export interface DeepSeekSessionResponse {
  code: number;
  data: {
    biz_code: number;
    biz_data: {
      id?: string;
      chat_session?: { id: string };
    };
  };
}

export interface DeepSeekPowChallenge {
  algorithm: string;
  challenge: string;
  salt: string;
  expire_at: number;
  difficulty: number;
  signature: string;
  target_path: string;
}

export interface DeepSeekPowResponse {
  code: number;
  data: {
    biz_code: number;
    biz_data: {
      challenge: DeepSeekPowChallenge;
    };
  };
}

export interface DeepSeekCompletionPayload {
  chat_session_id: string;
  parent_message_id: number | null;
  model_type: string;
  prompt: string;
  thinking_enabled?: boolean;
  search_enabled?: boolean;
  temperature?: number;
  top_p?: number;
  max_new_tokens?: number;
  stop?: string[];
  ref_file_ids?: string[];
}

export interface DeepSeekUploadResult {
  id: string;
  filename: string;
  bytes: number;
  status: string;
}

export const DEEPSEEK_HOST = 'chat.deepseek.com';

export const DEEPSEEK_URLS = {
  login: `https://${DEEPSEEK_HOST}/api/v0/users/login`,
  createSession: `https://${DEEPSEEK_HOST}/api/v0/chat_session/create`,
  createPow: `https://${DEEPSEEK_HOST}/api/v0/chat/create_pow_challenge`,
  completion: `https://${DEEPSEEK_HOST}/api/v0/chat/completion`,
  deleteSession: `https://${DEEPSEEK_HOST}/api/v0/chat_session/delete`,
  uploadFile: `https://${DEEPSEEK_HOST}/api/v0/file/upload_file`,
  fetchFiles: `https://${DEEPSEEK_HOST}/api/v0/file/fetch_files`,
  editMessage: `https://${DEEPSEEK_HOST}/api/v0/chat/edit_message`,
  completionTarget: '/api/v0/chat/completion',
  editMessageTarget: '/api/v0/chat/edit_message',
  uploadTarget: '/api/v0/file/upload_file',
};

export const FILE_UPLOAD_THRESHOLD = 100 * 1024;
export const MAX_FILE_SIZE = 10 * 1024 * 1024;
export const MAX_FILES = 50;

export const BASE_HEADERS: Record<string, string> = {
  Host: DEEPSEEK_HOST,
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'accept-charset': 'UTF-8',
  'User-Agent': 'DeepSeek/2.0.4 Android/35',
  'x-client-platform': 'android',
  'x-client-version': '2.0.4',
  'x-client-locale': 'zh_CN',
};
