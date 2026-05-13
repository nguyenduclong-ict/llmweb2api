export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: 'low' | 'high' | 'auto';
  };
}

export interface AnthropicImageContent {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export interface FileContent {
  type: 'input_file';
  file_id?: string;
  file_url?: string;
  file_data?: string;
  filename?: string;
}

export type ContentBlock = TextContent | ImageContent | FileContent;

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface InternalMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentBlock[];
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export type ThinkingLevel = 'Auto' | 'Fast' | 'Thinking';

export interface InternalRequest {
  model: string;
  providerModel?: string;
  providerName: string;
  messages: InternalMessage[];
  originalMessages?: InternalMessage[];
  stream: boolean;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  tools?: unknown[];
  toolChoice?: unknown;
  reasoningEffort?: string;
  thinking?: boolean;
  conversationId?: string;
  promptCacheKey?: string;
  thinkingLevel?: ThinkingLevel;
  reasoning?: unknown;
}

export interface InternalResponse {
  id: string;
  model: string;
  content: string;
  reasoningContent?: string;
  finishReason: string;
  toolCalls?: ToolCall[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    cumulativeInputTokens?: number;
    cumulativeOutputTokens?: number;
  };
  conversationId?: string;
}

export interface InternalStreamChunk {
  id: string;
  model: string;
  content: string;
  reasoningContent?: string;
  finishReason: string | null;
  toolCalls?: ToolCall[];
  toolCallDelta?: ToolCallDelta;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    cumulativeInputTokens?: number;
    cumulativeOutputTokens?: number;
  };
  conversationId?: string;
}

export type VendorFormat = 'openai' | 'anthropic' | 'gemini';

export interface ResolvedModel {
  vendorModel: string;
  providerModel: string;
  providerName: string;
  responseModel: string;
  thinking: boolean;
  search: boolean;
  thinkingLevel?: ThinkingLevel;
}
