# Request Flow

## Provider Limitations

### DeepSeek expert models

- `deepseek-v4-pro` uses `modelType=expert`.
- DeepSeek expert mode currently does not allow file upload attachments.
- Do not use the large-prompt file-upload fallback for `modelType=expert`; the prompt must stay inline or be reduced before calling `/api/v0/chat/completion`.
- This matters during conversation rollover (`max_messages_per_conversation`): replaying a long history into a new expert session can create a very large inline prompt and may return an empty stream with `finish_reason=stop`.

## Tổng quan

Backend hỗ trợ nhiều provider (DeepSeek, Qwen, ChatGPT) và nhiều adapter (OpenAI, Anthropic, Gemini). Mỗi request được route dựa trên adapter type, chuyển đổi sang `InternalRequest`, sau đó xử lý bởi core manager.

```
Request đến → Adapter parse → InternalRequest → Core Manager → Provider → Response
                                              ├── selectAccount
                                              ├── checkAuth / login
                                              ├── createSession
                                              ├── hash-based cache (nếu dùng)
                                              └── chat / chatStream
```

## Auth: Token & Session

### DeepSeek
- Login bằng email + password từ account settings
- Token được lưu trong `accounts.session` (JSON) + memory cache (`Map<accountId, string>`)
- Token expiry: 24h từ lúc login

### Qwen
- Dùng token trực tiếp từ account settings (không cần login)
- Token được truyền qua `Authorization: Bearer <token>`

### ChatGPT
- Đang phát triển (throw `not implemented yet`)

## Session Reuse (Shared by cache & non-cache)

```
sessionStore: Map<conversationId, SessionEntry>
  SessionEntry {
    providerSessionId: string     // ID session bên provider (DeepSeek/Qwen)
    providerName: string          // deepseek | qwen | chatgpt
    accountId: number             // Tài khoản nào được dùng
    parentMessageId?: string      // ID message cuối từ provider
    lastRequestMessageId?: string // ID message request cuối (cho hash cache)
  }
```

## Hash-Based Cache Flow

Cache dùng hash map thay vì lưu toàn bộ message array:

1. Hash từng message role `user` | `tool` bằng MD5
2. Hash map lưu trong DB (column `messages`) format: `{ hash → { parent_message_id, request_message_id } }`
3. Khi request đến, duyệt message mới, tìm hash match trong map
4. Xác định điểm phân kỳ (serial detection)
5. Gửi message mới với `parent_message_id` phù hợp

### Các trường hợp

| Case | Mô tả | Hành vi |
|------|-------|---------|
| **Normal append** | Message mới nối cuối | Gửi từ message mới, dùng `last_message_id` làm parent |
| **Revert** | User quay về message cũ | Phát hiện phân kỳ, dùng `parent_message_id` của hash cuối cùng match |
| **Full match** | Tất cả message đã có trong cache | Gọi `edit_message` tại message cuối |

### Tools caching

- Cột `tools_hash` trong `conversations`: MD5 của tools array
- Chỉ gửi tool system prompt khi `tools_hash` thay đổi
- Tránh gửi lại toàn bộ tool definitions mỗi request

### Cache Storage

| Thời điểm | Stream | Non-stream |
|-----------|--------|------------|
| Lưu hash | Ngay khi nhận chunk đầu tiên | Sau khi nhận response |

### last_used

- Cột `last_used` được cập nhật mỗi lần conversation được dùng
- Logic dọn dẹp dựa trên `last_used` thay vì `created_at`
- Conversation chỉ bị xóa khi không dùng trong khoảng thời gian đã đặt

### last_message_id

- Cột `last_message_id` lưu ID message cuối cùng từ provider (assistant response)
- Dùng làm `parent_message_id` cho message mới (không phải edit)
- Đảm bảo chain message đúng ngay cả khi hash chỉ lưu role `user`/`tool`

## No-Cache Flow

```
POST /v1/chat/completions (cache = false)
  → Adapter parse → InternalRequest
  → Route to provider (dựa trên model mapping)
  → selectAccount() → chọn account ngẫu nhiên từ enabled
  → checkAuth() → token từ DB/memory hoặc login
  → createSession() → provider.createSession()
  → provider.chat() hoặc provider.chatStream()
  → Adapter format → Response
```

## Title Generation Request

Các coding tool (OpenCode, Claude Code, v.v.) luôn gửi thêm 1 request song song để tạo tiêu đề. Request này có ít messages hơn (thường msgs=2), không có `conversation_id`.

→ Backend sẽ tạo session riêng cho title request. Đây là hành vi bình thường, **không phải bug**.

## Compaction Detection

**Không cần implement.** Khi coding agent compact, nó tự thay thế message history → `conversation_id` cũ bị mất khỏi payload → request tiếp theo không có `conversationId` → luồng tự kích hoạt `isNew = true` → tạo session mới.
