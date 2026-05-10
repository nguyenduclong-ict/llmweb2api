# llmweb2api

Biến tài khoản chat web (DeepSeek, Qwen, ChatGPT) thành API tương thích OpenAI / Anthropic / Gemini.

## Mục tiêu

Nhiều nền tảng AI cung cấp giao diện chat miễn phí nhưng không có API công khai. Dự án này hoạt động như một proxy trung gian, cho phép các công cụ (OpenCode, Cursor, Continue, v.v.) sử dụng tài khoản web làm backend:

```
Coding Agent (OpenAI / Anthropic / Gemini API)
        │
        ▼
  llmweb2api (port 3000)
  - Multi-adapter: OpenAI, Anthropic, Gemini
  - Multi-provider: DeepSeek, Qwen, ChatGPT
  - Quản lý session, hash cache, tool calling
        │
        ▼
  Chat Web API (chat.deepseek.com / chat.qwen.ai / chatgpt.com)
  - Chat thật bằng tài khoản người dùng
```

Bạn chỉ cần tài khoản trên nền tảng tương ứng (email + password hoặc token), server sẽ tự động login, tạo session và dịch request/response qua lại.

## Công nghệ

| Thành phần      | Stack                                                    |
| --------------- | -------------------------------------------------------- |
| Backend         | Node.js, TypeScript, Express                             |
| Database        | SQLite (better-sqlite3)                                  |
| Frontend        | React 19, Vite 6, Tailwind CSS v4, Radix UI, Recharts    |
| PoW (DeepSeek)  | Go WASM (nhanh) + JS fallback (chậm hơn)                 |
| Monorepo        | pnpm workspace (`packages/backend` + `packages/web`)     |

## Cài đặt

Yêu cầu: **Node.js >= 22**, **pnpm >= 9**

```bash
# Clone repository
git clone <repo-url>
cd llmweb2api

# Cài dependencies
pnpm install
```

> `postinstall` sẽ build Go WASM cho Proof-of-Work (DeepSeek). Nếu chưa cài Go, script sẽ báo warning và dùng JS fallback — chậm hơn nhưng vẫn dùng được.

## Docker

```bash
docker compose up -d
```

Server chạy tại `http://localhost:3567`.

## Cấu hình

Tạo file `.env` từ mẫu:

```bash
cp .env.example .env
```

| Biến                 | Mặc định        | Mô tả                        |
| -------------------- | --------------- | ---------------------------- |
| `PORT`               | `3000`          | Cổng server                  |
| `HOST`               | `0.0.0.0`       | Địa chỉ bind                 |
| `DASHBOARD_PASSWORD` | `admin123`      | Mật khẩu đăng nhập dashboard |
| `DB_PATH`            | `./data/app.db` | Đường dẫn file SQLite        |

Tài khoản được quản lý qua Dashboard, không cần khai báo trong `.env`.

## Chạy

### Development (backend + frontend, auto-reload)

```bash
pnpm dev
```

- Backend: `http://localhost:3000`
- Frontend: `http://localhost:5173` (proxy `/api` → `:3000`)

### Production

```bash
pnpm build
pnpm start
```

Server chạy tại `http://localhost:3000`, phục vụ cả API và giao diện dashboard từ một cổng duy nhất.

## Thiết lập ban đầu

1. **Đăng nhập dashboard**: Mở `http://localhost:3000`, đăng nhập bằng mật khẩu trong `DASHBOARD_PASSWORD`.

2. **Thêm tài khoản**: Vào tab **Providers** → **Add Account** → Chọn provider (`deepseek`, `qwen`, `chatgpt`) và nhập thông tin đăng nhập.
   - DeepSeek: email + password
   - Qwen: token (lấy từ tài khoản Qwen)
   - ChatGPT: đang phát triển

3. **Tạo API Key**: Vào tab **API Keys** → **Create New API Key**. Mặc định **Enable cache** được bật để tối ưu token usage.

4. **Dùng với OpenCode**: Thêm provider vào `~/.config/opencode/opencode.json`:

```json
{
  "provider": {
    "llmweb2api": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "llmweb2api",
      "options": {
        "baseURL": "http://localhost:3000/v1",
        "apiKey": "sk-your-key-here"
      },
      "models": {
        "deepseek-v4-flash": {
          "name": "deepseek-v4-flash",
          "limit": {
            "output": 32000,
            "context": 480000
          },
          "options": {
            "thinking": {
              "type": "enabled"
            }
          },
          "compaction": {
            "threshold": 0.8
          }
        },
        "deepseek-v4-pro": {
          "name": "deepseek-v4-pro",
          "limit": {
            "output": 32000,
            "context": 480000
          },
          "options": {
            "thinking": {
              "type": "enabled"
            }
          },
          "compaction": {
            "threshold": 0.8
          }
        }
      }
    }
  }
}
```

> Thay `sk-your-key-here` bằng API key đã tạo ở bước 3. Nếu server chạy ở máy khác hoặc cổng khác, sửa `baseURL` tương ứng.

## Tính năng chính

- **Multi-provider**: DeepSeek (web chat), Qwen (API token), ChatGPT (đang phát triển).
- **Multi-adapter**: Tương thích OpenAI (`/v1`), Anthropic (`/v1/messages`), Gemini (`/v1beta/models/*:generateContent`).
- **Hash-based cache**: Chỉ gửi message mới lên provider. Revert và edit được xử lý thông minh qua `parent_message_id`.
- **Reasoning / Thinking**: Hỗ trợ DeepSeek và Qwen với suy nghĩ (thinking).
- **Large prompt**: Prompt > 100KB được upload dưới dạng file đính kèm.
- **Model mapping**: Map model name linh hoạt (ví dụ `gpt-4o` → `deepseek-v4-flash`, `claude-sonnet-4-6` → `deepseek-v4-flash`).
- **Multi-account**: Hỗ trợ nhiều tài khoản, tự chọn ngẫu nhiên tài khoản đang enabled.
- **Analytics**: Dashboard với biểu đồ KPI, request volume, status code, latency, token usage.
- **Tự động dọn dẹp**: Xóa log và conversation cũ dựa trên `last_used` (chỉ xóa khi không dùng trong khoảng thời gian đã đặt).

## API Endpoints

### LLM

| Endpoint                              | Định dạng  |
| ------------------------------------- | ---------- |
| `POST /v1/chat/completions`           | OpenAI     |
| `POST /v1/responses`                  | OpenAI     |
| `POST /v1/messages`                   | Anthropic  |
| `POST /v1beta/models/*:generateContent` | Gemini   |
| `POST /v1beta/models/*:streamGenerateContent` | Gemini |

### Quản lý

| Endpoint                   | Mô tả                         |
| -------------------------- | ----------------------------- |
| `POST /api/auth/login`     | Đăng nhập dashboard           |
| `GET/POST /api/accounts`   | Quản lý tài khoản (provider)  |
| `PUT/DELETE /api/accounts/:id` | Sửa / xóa tài khoản       |
| `GET/POST /api/api-keys`   | Quản lý API key               |
| `PUT/DELETE /api/api-keys/:id` | Sửa / xóa API key          |
| `GET /api/logs`            | Xem log request               |
| `GET/PUT /api/settings`    | Cấu hình hệ thống             |

### Khác

| Endpoint             | Mô tả              |
| -------------------- | ------------------ |
| `GET /health`        | Health check       |
| `GET /api/stats`     | Thống kê tổng quan |
| `GET /api/analytics` | Dữ liệu analytics  |

## Cấu trúc thư mục

```
packages/
├── backend/
│   ├── src/
│   │   ├── index.ts                     # Entry point
│   │   ├── app/
│   │   │   ├── database.ts              # SQLite + migrations
│   │   │   ├── server.ts                # Express setup
│   │   │   ├── middleware/
│   │   │   │   ├── auth.ts              # Bearer token / API key auth
│   │   │   │   ├── logger.ts            # Request logging
│   │   │   │   └── rateLimit.ts         # Rate limiting
│   │   │   ├── routes/
│   │   │   │   ├── api.ts               # /v1/chat/completions, /v1/messages, /v1beta/...
│   │   │   │   ├── management.ts        # /api/accounts, /api/api-keys, ...
│   │   │   │   ├── stats.ts             # /api/stats/*
│   │   │   │   └── analytics.ts         # /api/analytics/*
│   │   │   ├── models/
│   │   │   │   ├── account.ts           # Provider account CRUD
│   │   │   │   ├── apiKey.ts            # API key CRUD
│   │   │   │   ├── conversation.ts      # Hash cache + last_used persistence
│   │   │   │   └── log.ts               # Request log persistence
│   │   │   └── services/
│   │   │       ├── analyticsService.ts  # Analytics queries
│   │   │       ├── modelService.ts      # Model mapping (OpenAI/Anthropic/Gemini)
│   │   │       ├── providerService.ts   # Provider account lookup
│   │   │       ├── settingsService.ts   # Key-value settings
│   │   │       └── statsService.ts      # Stats queries
│   │   ├── adapters/
│   │   │   ├── openai/                  # OpenAI ↔ Internal format
│   │   │   ├── anthropic/               # Anthropic ↔ Internal format
│   │   │   └── gemini/                  # Gemini ↔ Internal format
│   │   ├── providers/
│   │   │   ├── core/
│   │   │   │   ├── manager.ts           # Session, cache, account orchestration
│   │   │   │   ├── hash.ts              # Message hashing & hash cache
│   │   │   │   ├── tool_parser.ts       # XML tool call parser
│   │   │   │   ├── tool_prompt.ts       # Tool system prompt builder
│   │   │   │   └── tool_sieve.ts        # Stream tool call extraction
│   │   │   ├── deepseek/
│   │   │   │   ├── index.ts             # DeepSeekProvider
│   │   │   │   ├── client.ts            # API client (login, session, PoW, completion)
│   │   │   │   ├── models.ts            # Provider model definitions
│   │   │   │   ├── types.ts             # API types & constants
│   │   │   │   └── pow_native.ts        # WASM PoW initializer
│   │   │   ├── qwen/
│   │   │   │   ├── index.ts             # QwenProvider
│   │   │   │   ├── client.ts            # API client (token auth, completion)
│   │   │   │   ├── models.ts            # Provider model definitions
│   │   │   │   ├── types.ts             # API types & constants
│   │   │   │   └── transport.ts         # HTTP transport helpers
│   │   │   └── chatgpt/
│   │   │       └── index.ts             # ChatGPTProvider (WIP)
│   │   ├── types/
│   │   │   ├── adapter.ts
│   │   │   ├── common.ts
│   │   │   └── provider.ts
│   │   └── tests/
│   └── scripts/
│       ├── build_pow_go.js              # Build Go WASM
│       └── copy_pow_assets.js           # Copy WASM assets after build
└── web/
    ├── index.html
    ├── vite.config.ts
    └── src/
        ├── App.tsx                       # App shell + routing
        ├── main.tsx                      # Entry point
        ├── api/client.ts                 # API client
        ├── pages/
        │   ├── Login.tsx                 # Dashboard login
        │   ├── Providers.tsx             # Account management
        │   ├── ApiKeys.tsx               # API key management
        │   ├── Analysis.tsx              # Analytics dashboard
        │   ├── Logs.tsx                  # Request log viewer
        │   └── Settings.tsx              # Settings + model maps
        ├── components/
        │   ├── Layout.tsx                # App layout + sidebar
        │   ├── Sidebar.tsx               # Navigation sidebar
        │   ├── AccountModal.tsx          # Add/edit account wrapper
        │   ├── AccountModalForm.tsx      # Add/edit account form
        │   ├── ApiKeyModal.tsx           # Add/edit API key
        │   ├── charts/                   # Recharts components
        │   └── ui/                       # Radix UI wrappers
        └── styles/
            └── global.css                # Tailwind + custom styles
```

## License

MIT
