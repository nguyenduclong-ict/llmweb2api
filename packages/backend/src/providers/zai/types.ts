export interface ZaiMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ZaiCreateChatResult {
  chatId: string;
  messageId: string;
}

export interface ZaiStreamInput {
  token: string;
  userId: string;
  chatId: string;
  requestId: string;
  messageId: string;
  parentMessageId: string | null;
  model: string;
  messages: ZaiMessage[];
  signaturePrompt: string;
  captchaVerifyParam?: string;
  signal?: AbortSignal;
  enableThinking: boolean;
  autoWebSearch: boolean;
}

export interface ZaiStreamEvent {
  id?: string;
  phase?: 'thinking' | 'answer' | 'done';
  delta?: string;
  done?: boolean;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  error?: string;
  raw?: unknown;
}
