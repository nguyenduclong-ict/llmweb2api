# Provider Investigation Notes

This document records provider-specific findings discovered while debugging long conversations, rollover, and Z.ai integration.

## DeepSeek Expert Rollover

### Symptom

A long active conversation using `deepseek-v4-pro` can stop working after being idle or after message count rollover. Logs show a new provider conversation is created, then DeepSeek returns an empty stream:

```text
finish_reason=stop
completion_tokens=0
```

Starting a brand-new public conversation can still work.

### Cause

`deepseek-v4-pro` uses DeepSeek `modelType=expert`. Expert mode currently does not support file upload. When rollover tries to replay a large history, the prompt must stay inline. Large inline prompts can be rejected by DeepSeek with an empty stop response instead of a clear error.

### Rollover Strategy

Preferred flow when the current upstream conversation still exists:

1. Ask the current upstream conversation to summarize itself.
2. Treat the summary as hidden internal context.
3. Inject that summary before the next user message.
4. Create a new upstream conversation and send the compacted request.

Fallback flow when the old upstream conversation is missing or deleted:

1. Create a transient upstream conversation.
2. Hydrate context in chunks.
3. Prefix each chunk with:

   ```text
   *** remember this contents, just reply me i remembered ***
   ```

4. Wait for the short acknowledgement response instead of cancelling immediately.
5. Add a final summary prompt.
6. Use the produced summary as hidden rollover context.
7. Delete the transient upstream conversation after summary completes.

Tested notes:

- Cancelling immediately after message id or first content is unreliable. Later chunks can be empty and summary can fail.
- A short acknowledgement prompt is more reliable because the model stores the chunk while only returning a small response.
- `50k` chars per hydration chunk with around `1s` delay between chunks was the safer observed range.
- Do not dispose/delete the transient session before the summary stream has fully completed.

## Z.ai Provider

### Supported Initial Scope

The Z.ai provider was implemented for:

- Text chat.
- Streaming.
- Non-streaming by consuming and aggregating stream chunks.
- Thinking/reasoning content.
- Auto web search and preview mode defaults.
- Managed prompt/tool parsing through the app, not native Z.ai tool calls.

Not implemented in the initial pass:

- File/image upload.
- Native Z.ai tool calling.
- Title/tag generation handling beyond sending the same flags as the web client.

### JWT Account Settings

Account settings use:

```json
{
  "token": "<jwt from chat.z.ai cookie>"
}
```

Optional captcha setting:

```json
{
  "token": "<jwt>",
  "captchaVerifyParam": "<fresh Aliyun captcha token>"
}
```

`captchaVerifyParam` is short-lived and likely bound to browser/session/fingerprint data. A hardcoded old value should not be expected to keep working.

### X-Signature

The web bundle `index-COJbO0Nn.js` computes `X-Signature` with this logic:

```text
metadata = requestId,<requestId>,timestamp,<timestampMs>,user_id,<userId>
base64Message = base64(utf8(signature_prompt))
canonical = <metadata>|<base64Message>|<timestampMs>
windowIndex = floor(timestampMs / (5 * 60 * 1000))
derivedKey = hmacSha256("key-@@@@)))()((9))-xxxx&&&%%%%%", String(windowIndex)).hex
signature = hmacSha256(derivedKey, canonical).hex
```

`timestamp`, `requestId`, `user_id`, and `signature_timestamp` must match the values used to compute the signature.

The browser builds the query fingerprint from real browser values:

- `navigator.userAgent`
- `navigator.language`
- `navigator.languages`
- `Intl.DateTimeFormat().resolvedOptions().timeZone`
- `screen.width`, `screen.height`, `screen.colorDepth`
- `window.innerWidth`, `window.innerHeight`
- `window.devicePixelRatio`
- `location.href`, `pathname`, `search`, `hash`, `host`, `hostname`, `protocol`
- `document.referrer`, `document.title`
- browser and OS names

If the signature is valid but the fingerprint/cookies do not look like the browser session, Z.ai can still require captcha.

### Captcha Flow

Z.ai currently can return:

```json
{
  "code": "FRONTEND_CAPTCHA_REQUIRED",
  "captcha_error_type": "missing_param"
}
```

The web client handles this by loading Aliyun captcha:

```text
https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js
```

Relevant config from the web bundle:

```text
region: sgp
prefix: no8xfe
SceneId: didk33e0 for chat.z.ai
mode: popup
```

The web client calls `window.initAliyunCaptcha(...)` with hidden DOM elements and receives the captcha token in the `success` callback. That callback value is sent as top-level body field:

```json
{
  "captcha_verify_param": "<callback value>"
}
```

This token is not just the visible slider answer. It is produced by the Aliyun SDK after browser-side checks and is likely short-lived and bound to the browser context.

Practical approaches:

- Browser-in-the-loop: use a real Chrome session to obtain a fresh `captcha_verify_param`, then immediately reuse it.
- Browser-backed provider: issue the actual Z.ai request from the same browser context instead of pure headless HTTP.
- Fail clearly when no fresh captcha token is available.

No public GitHub repo was found that locally bypasses this Aliyun SDK flow for Z.ai. Public examples are mostly generic slider automation or third-party captcha solving services, not local token generation.

### Browser Request Replay

For debugging browser-captured Z.ai requests, use:

```powershell
pnpm --filter @llmweb2api/backend exec tsx scripts/test_zai_raw_fetch.ts --input C:\Users\ADMIN\Desktop\Code\chat2api\llmweb2api\tmp\zai_raw_fetch.txt --all --max-chunks 20
```

The input file should contain raw browser `fetch(...)` calls in order, typically:

1. `POST /api/v1/chats/new`
2. `POST /api/v2/chat/completions`

Keep these browser-captured values fresh and unchanged:

- `Authorization`
- `Cookie`
- `X-Signature`
- `X-FE-Version`
- `X-Region`
- full query string
- `captcha_verify_param`
- `chat_id`
- `current_user_message_id`
- `current_user_message_parent_id`
- `signature_prompt`
