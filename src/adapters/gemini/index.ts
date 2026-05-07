import type { Adapter } from '../../types/adapter';
import type {
  InternalRequest,
  InternalResponse,
  InternalStreamChunk,
  InternalMessage,
  ContentBlock,
} from '../../types/common';
import { resolveModel } from '../../app/services/modelService';

function extractGeminiContent(part: any): string {
  if (typeof part === 'string') return part;
  if (part.text !== undefined) return part.text;
  if (part.inlineData) return `[inline_data: ${part.inlineData.mimeType}]`;
  if (part.functionCall)
    return `[functionCall: ${part.functionCall.name}(${JSON.stringify(part.functionCall.args ?? {})})]`;
  if (part.functionResponse)
    return `[functionResponse: ${part.functionResponse.name} = ${JSON.stringify(part.functionResponse.response ?? {})}]`;
  if (part.fileData) return `[file: ${part.fileData.fileUri}]`;
  return JSON.stringify(part);
}

function hasImageParts(parts: any[]): boolean {
  return parts.some((p) => p.inlineData || p.fileData);
}

function extractPartsAsBlocks(parts: any[]): ContentBlock[] {
  return parts.map((part) => {
    if (part.inlineData) {
      return {
        type: 'image_url' as const,
        image_url: {
          url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
        },
      };
    }
    if (part.fileData) {
      return {
        type: 'image_url' as const,
        image_url: { url: part.fileData.fileUri },
      };
    }
    return { type: 'text' as const, text: extractGeminiContent(part) };
  });
}

function geminiThinkingToFlag(config?: any): boolean | undefined {
  if (!config) return undefined;
  return config.thinkingBudget !== undefined || config.thinkingLevel !== undefined;
}

export const geminiAdapter: Adapter = {
  name: 'gemini',

  parseRequest(body: any): InternalRequest {
    const vendorModel = body.modelOverride ?? 'gemini-pro';
    const genConfig = body.generationConfig ?? {};
    const resolved = resolveModel('gemini', vendorModel, {
      thinking: geminiThinkingToFlag(genConfig),
    });

    const messages: InternalMessage[] = [];

    if (body.systemInstruction) {
      const sysParts = body.systemInstruction.parts ?? [body.systemInstruction];
      const sysContent = (Array.isArray(sysParts) ? sysParts : [sysParts]).map(extractGeminiContent).join('\n');
      messages.push({ role: 'system', content: sysContent });
    }

    for (const c of body.contents ?? []) {
      const role = c.role === 'model' ? 'assistant' : 'user';
      const parts = c.parts ?? [];
      if (parts.length === 0) continue;
      const content: string | ContentBlock[] = hasImageParts(parts)
        ? extractPartsAsBlocks(parts)
        : parts.map(extractGeminiContent).join('\n');
      if (content) messages.push({ role, content });
    }

    return {
      model: resolved.responseModel,
      providerModel: resolved.providerModel,
      messages,
      stream: false,
      maxTokens: genConfig.maxOutputTokens,
      temperature: genConfig.temperature,
      topP: genConfig.topP,
      stop: genConfig.stopSequences,
      reasoningEffort: resolved.thinking ? 'high' : undefined,
    };
  },

  formatResponse(internal: InternalResponse): unknown {
    const parts: Record<string, unknown>[] = [];

    if (internal.reasoningContent) {
      parts.push({ text: internal.reasoningContent, thought: true });
    }

    if (internal.toolCalls && internal.toolCalls.length > 0) {
      for (const tc of internal.toolCalls) {
        parts.push({
          functionCall: {
            name: tc.function.name,
            args: JSON.parse(tc.function.arguments || '{}'),
          },
        });
      }
    } else {
      parts.push({ text: internal.content });
    }

    return {
      candidates: [
        {
          content: { parts, role: 'model' },
          finishReason: internal.finishReason,
          index: 0,
          safetyRatings: [],
        },
      ],
      usageMetadata: {
        promptTokenCount: internal.usage.inputTokens,
        candidatesTokenCount: internal.usage.outputTokens,
        totalTokenCount: internal.usage.inputTokens + internal.usage.outputTokens,
        ...(internal.usage.reasoningTokens !== undefined ? { thoughtsTokenCount: internal.usage.reasoningTokens } : {}),
      },
      modelVersion: internal.model,
    };
  },

  formatStreamChunk(chunk: InternalStreamChunk): string {
    const parts: Record<string, unknown>[] = [];

    if (chunk.reasoningContent) {
      parts.push({ text: chunk.reasoningContent, thought: true });
    }
    if (chunk.content) {
      parts.push({ text: chunk.content });
    }

    if (parts.length === 0 && !chunk.finishReason) return '';

    const candidate: Record<string, unknown> = {
      content: { parts, role: 'model' },
      index: 0,
    };

    if (chunk.finishReason) {
      candidate.finishReason = chunk.finishReason;
    }

    const data: Record<string, unknown> = { candidates: [candidate] };

    if (chunk.usage) {
      data.usageMetadata = {
        promptTokenCount: chunk.usage.inputTokens,
        candidatesTokenCount: chunk.usage.outputTokens,
        totalTokenCount: chunk.usage.inputTokens + chunk.usage.outputTokens,
      };
    }

    return JSON.stringify(data) + '\r\n';
  },
};
