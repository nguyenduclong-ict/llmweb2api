# DeepSeek Request Flow

## Auth: Token Management

Mỗi account lưu token trong `accounts.session` (JSON). Luồng auth:

```
checkAuth(accountId)
├── session.token tồn tại + session.tokenExpiresAt > now?
│   └── ✅ return token (tái sử dụng)
├── session.token tồn tại nhưng hết hạn?
│   └── ❌ gọi login() → lưu token + expiresAt vào DB → return
└── chưa có session?
    └── ❌ gọi login() → lưu token + expiresAt vào DB → return
```

- Token được cache trong memory (Map<accountId, string>) để tránh đọc DB
- Token expiry: 24h từ lúc login
- Fallback expiry: 24h nếu DeepSeek không trả về thời hạn

## Chat Session: Per-Request

- **Chat session KHÔNG được share giữa các request** — mỗi request tạo chat session mới
- Token mới được cache (DB + memory), chat session luôn fresh

---

## No Cache Flow

```
POST /v1/chat/completions (apiKeyCache = false)
  → selectAccount() → chọn account ngẫu nhiên
  → checkAuth() → token từ DB/memory hoặc login
  → createChatSession() → client.createSession(token) → sessionId
  → buildPrompt() → XML prompt từ messages
  → getPow() → PoW mới
  → client.chatCompletion(token, pow, payload) → SSE stream
  → parse & format → response
```

---

## Cache Flow

```
POST /v1/chat/completions (apiKeyCache = true)

a) Có conversation_id trong request body:
  → checkAuth() → token
  → createChatSession() → sessionId mới (KHÔNG dùng lại session cũ)
  → buildPrompt() → chỉ gửi diff messages
  → getPow() → PoW mới
  → client.chatCompletion(token, pow, payload) → SSE stream
  → parse & format → response
  → inject {conversation_id:xxx} vào reasoning chunk đầu tiên

b) Không có conversation_id:
  → checkAuth() → token
  → createChatSession() → sessionId mới
  → buildPrompt() → tất cả messages
  → getPow() → PoW mới
  → client.chatCompletion(token, pow, payload) → SSE stream
  → lưu conversation vào DB + memory cache
  → inject {conversation_id:xxx} vào reasoning chunk đầu tiên
```

## Known: Extra Title Generation Request

Các coding tool (OpenCode, Claude Code, v.v.) luôn gửi thêm 1 request song song với request chat đầu tiên để tạo tiêu đề (title) cho cuộc hội thoại. Request này có ít messages hơn (thường msgs=2), không có `conversation_id`, và đến cùng lúc với request thật (msgs=3+).

→ Backend sẽ tạo 2 DeepSeek session: 1 cho title, 1 cho chat thật. Đây là hành vi bình thường, **không phải bug**.

Khi debug thấy nhiều conversation được tạo trên DeepSeek web, kiểm tra số lượng messages trong mỗi request để xác định đâu là title request.

## Compaction Detection

**Không cần thiết.** Khi coding agent compact, nó tự thay thế message history → `conversation_id` cũ bị mất khỏi payload → request tiếp theo không có `conversationId` → luồng tự kích hoạt `isNew = true` → tạo conversation mới. Không cần implement logic detection phía backend.
