import crypto from 'crypto';
import type { QwenFilePayload, StsTokenData, StsTokenResponse, UploadFileInfo } from './types';
import { QWEN_API_URLS, QWEN_BASE_URL } from './types';
import { qwenTlsJson, qwenTlsRequest, qwenTlsStreamLines } from './transport';

function uuidv4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export async function createSession(token: string, model: string, chatType: string): Promise<string> {
  const body = {
    title: 'New Chat',
    models: [model],
    chat_mode: 'normal',
    chat_type: chatType,
    timestamp: Math.floor(Date.now() / 1000),
    project_id: '',
  };

  const data = await qwenTlsJson<{ success: boolean; data?: { id: string }; msg?: string }>({
    token,
    url: QWEN_API_URLS.chatsNew,
    body,
  });

  if (!data.success || !data.data?.id) {
    throw new Error(`Failed to create Qwen chat session: ${data.msg || 'unknown error'}`);
  }

  return data.data.id;
}

export async function* streamCompletion(
  token: string,
  chatId: string,
  model: string,
  parentId: string | null,
  content: string,
  chatType: string,
  files: QwenFilePayload[],
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const messageFid = uuidv4();
  const childId = uuidv4();

  const payload = {
    stream: true,
    version: '2.1',
    incremental_output: true,
    chat_id: chatId,
    chat_mode: 'normal',
    model,
    parent_id: parentId,
    messages: [
      {
        fid: messageFid,
        parentId,
        childrenIds: [childId],
        role: 'user',
        content,
        user_action: 'chat',
        files,
        timestamp: Math.floor(Date.now() / 1000),
        models: [model],
        chat_type: chatType,
        feature_config: {
          thinking_enabled: true,
          output_schema: 'phase',
          research_mode: 'normal',
          auto_thinking: true,
          thinking_mode: 'Auto',
          thinking_format: 'summary',
          auto_search: false,
          function_calling: false,
          enable_tools: false,
          tool_choice: 'none',
        },
        extra: { meta: { subChatType: chatType } },
        sub_chat_type: chatType,
        parent_id: parentId,
      },
    ],
    timestamp: Math.floor(Date.now() / 1000),
  };

  yield* qwenTlsStreamLines(
    {
      token,
      url: `${QWEN_API_URLS.chatCompletions}?chat_id=${chatId}`,
      referer: `${QWEN_BASE_URL}/c/${chatId}`,
      body: payload,
    },
    signal,
  );
}

export async function deleteSession(token: string, chatId: string): Promise<void> {
  await qwenTlsRequest({
    token,
    url: `${QWEN_BASE_URL}/api/v2/chats/${chatId}`,
    method: 'DELETE',
    referer: `${QWEN_BASE_URL}/c/${chatId}`,
  });
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function formatOssDate(date = new Date()): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`;
}

function formatOssDateScope(date = new Date()): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

async function sha256Hex(input: Uint8Array | string): Promise<string> {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const hash = crypto.createHash('sha256').update(bytes).digest();
  return toHex(new Uint8Array(hash));
}

async function hmacSha256(key: Uint8Array, content: string): Promise<Uint8Array> {
  const hmac = crypto.createHmac('sha256', key).update(content).digest();
  return new Uint8Array(hmac);
}

async function buildOssSignedHeaders(
  uploadUrl: string,
  tokenData: StsTokenData,
  file: UploadFileInfo,
): Promise<Record<string, string>> {
  const parsedUrl = new URL(uploadUrl);
  const query = parsedUrl.searchParams;
  const credentialFromQuery = decodeURIComponent(query.get('x-oss-credential') || '');
  const credentialParts = credentialFromQuery.split('/');

  const dateScope = credentialParts[1] || formatOssDateScope();
  const region = credentialParts[2] || 'ap-southeast-1';
  const xOssDate = query.get('x-oss-date') || formatOssDate();

  const hostParts = parsedUrl.hostname.split('.');
  const bucket = hostParts.length > 0 ? hostParts[0] : '';
  const objectPath = parsedUrl.pathname || '/';
  const canonicalUri = bucket ? `/${bucket}${objectPath}` : objectPath;
  const xOssUserAgent = 'aliyun-sdk-js/6.23.0';
  const canonicalHeaders =
    [
      `content-type:${file.mimeType}`,
      'x-oss-content-sha256:UNSIGNED-PAYLOAD',
      `x-oss-date:${xOssDate}`,
      `x-oss-security-token:${tokenData.security_token}`,
      `x-oss-user-agent:${xOssUserAgent}`,
    ].join('\n') + '\n';
  const canonicalRequest = ['PUT', canonicalUri, '', canonicalHeaders, '', 'UNSIGNED-PAYLOAD'].join('\n');

  const credentialScope = `${dateScope}/${region}/oss/aliyun_v4_request`;
  const stringToSign = ['OSS4-HMAC-SHA256', xOssDate, credentialScope, await sha256Hex(canonicalRequest)].join('\n');

  const kDate = await hmacSha256(new TextEncoder().encode(`aliyun_v4${tokenData.access_key_secret}`), dateScope);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, 'oss');
  const kSigning = await hmacSha256(kService, 'aliyun_v4_request');
  const signature = toHex(await hmacSha256(kSigning, stringToSign));

  return {
    Accept: '*/*',
    'Content-Type': file.mimeType,
    authorization: `OSS4-HMAC-SHA256 Credential=${tokenData.access_key_id}/${credentialScope},Signature=${signature}`,
    'x-oss-content-sha256': 'UNSIGNED-PAYLOAD',
    'x-oss-date': xOssDate,
    'x-oss-security-token': tokenData.security_token,
    'x-oss-user-agent': xOssUserAgent,
    Referer: QWEN_BASE_URL + '/',
  };
}

export async function uploadFile(token: string, file: UploadFileInfo): Promise<QwenFilePayload> {
  const filetype = file.mimeType.startsWith('image/') ? 'image' : 'document';

  const stsData = await qwenTlsJson<StsTokenResponse>({
    token,
    url: `${QWEN_BASE_URL}/api/v2/files/getstsToken`,
    body: {
      filename: file.filename,
      filesize: file.bytes.length,
      filetype,
    },
  });

  if (!stsData.success || !stsData.data) {
    throw new Error(`Failed to get upload token: ${stsData.msg || 'unknown error'}`);
  }

  const tokenData = stsData.data;
  const uploadUrl = typeof tokenData.file_url === 'string' ? tokenData.file_url.split('?')[0] : '';
  if (!uploadUrl) {
    throw new Error('Upload failed: missing upload URL');
  }

  const signedHeaders = await buildOssSignedHeaders(tokenData.file_url, tokenData, file);
  const uploadResp = await fetch(uploadUrl, {
    method: 'PUT',
    headers: signedHeaders,
    body: file.bytes,
  });

  if (!uploadResp.ok) {
    const detail = await uploadResp.text().catch(() => '');
    throw new Error(`Upload failed with status ${uploadResp.status}${detail ? `: ${detail}` : ''}`);
  }

  const now = Date.now();
  const fileUrl = tokenData.file_url;
  const fileId =
    tokenData.file_id ||
    (() => {
      try {
        const pathname = decodeURIComponent(new URL(fileUrl).pathname);
        const fname = pathname.split('/').pop() || '';
        if (fname.includes('_')) return fname.split('_')[0];
      } catch {
        /* ignore */
      }
      return uuidv4();
    })();

  const isDocument = filetype === 'document';
  const showType = isDocument ? 'file' : filetype;
  const fileClass = isDocument ? 'document' : filetype === 'image' ? 'vision' : filetype;
  const uploadTaskId = uuidv4();

  return {
    type: showType,
    file: {
      created_at: now,
      data: {},
      filename: file.filename,
      hash: null,
      id: fileId,
      meta: {
        name: file.filename,
        size: file.bytes.length,
        content_type: file.mimeType,
      },
      update_at: now,
    },
    id: fileId,
    url: fileUrl,
    name: file.filename,
    collection_name: '',
    progress: 0,
    status: 'uploaded',
    is_uploading: false,
    error: '',
    showType,
    file_class: fileClass,
    itemId: uuidv4(),
    greenNet: 'success',
    size: file.bytes.length,
    file_type: file.mimeType,
    uploadTaskId,
  };
}
