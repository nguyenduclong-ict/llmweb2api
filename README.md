# llmweb2api

Biến tài khoản DeepSeek Chat (web) thành OpenAI API để dùng với **OpenCode**.

## Mục tiêu

DeepSeek cung cấp giao diện chat miễn phí tại [chat.deepseek.com](https://chat.deepseek.com) nhưng không có API công khai. Dự án này hoạt động như một proxy trung gian, cho phép OpenCode (và các công cụ tương thích OpenAI API) sử dụng tài khoản DeepSeek web làm backend:

```
OpenCode (OpenAI API)
        │
        ▼
  llmweb2api (port 3000)
  - Định dạng OpenAI
  - Quản lý session, cache, tool calling
        │
        ▼
  DeepSeek Chat API (chat.deepseek.com)
  - Chat thật bằng tài khoản DeepSeek
```

Bạn chỉ cần tài khoản DeepSeek (email + password), server sẽ tự động login, giải Proof-of-Work, tạo session và dịch request/response qua lại giữa OpenAI API và DeepSeek Chat API.

## Công nghệ

| Thành phần      | Stack                                                 |
| --------------- | ----------------------------------------------------- |
| Backend         | Node.js, TypeScript, Express                          |
| Database        | SQLite (better-sqlite3)                               |
| Frontend        | React 19, Vite 6, Tailwind CSS v4, Radix UI, Recharts |
| PoW             | Go WASM (nhanh) + JS fallback (chậm hơn)              |
| Package manager | pnpm                                                  |

## Cài đặt

Yêu cầu: **Node.js >= 18**, **pnpm**

```bash
# Clone repository
git clone <repo-url>
cd llmweb2api

# Cài dependencies
pnpm install
```

> `postinstall` sẽ build Go WASM cho Proof-of-Work. Nếu chưa cài Go, script sẽ báo warning và dùng JS fallback — chậm hơn nhưng vẫn dùng được.

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

Tài khoản DeepSeek được quản lý qua Dashboard, không cần khai báo trong `.env`.

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

### Chạy backend riêng

```bash
npx tsx src/index.ts
```

## Thiết lập ban đầu

1. **Đăng nhập dashboard**: Mở `http://localhost:3000`, đăng nhập bằng mật khẩu trong `DASHBOARD_PASSWORD`.

2. **Thêm tài khoản DeepSeek**: Vào tab **Providers** → **Add Account** → Nhập email + password tài khoản DeepSeek.

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

- **Cache hội thoại**: Hash-based message tracking — chỉ gửi message mới lên DeepSeek, revert/edit được xử lý thông minh qua `edit_message`.
- **Reasoning / Thinking**: Hỗ trợ deepseek-v4-pro với suy nghĩ (thinking).
- **Large prompt**: Prompt > 100KB được upload dưới dạng file đính kèm.
- **Model mapping**: Map model name linh hoạt (ví dụ `gpt-4o` → `deepseek-v4-flash`).
- **Multi-account**: Hỗ trợ nhiều tài khoản DeepSeek, tự chọn ngẫu nhiên tài khoản đang enabled.
- **Analytics**: Dashboard với biểu đồ KPI, request volume, status code, latency, token usage.
- **Tự động dọn dẹp**: Xóa log và conversation cũ theo cấu hình retention.

## API Endpoints

### LLM

| Endpoint                    | Định dạng |
| --------------------------- | --------- |
| `POST /v1/chat/completions` | OpenAI    |

### Quản lý

| Endpoint                 | Mô tả                      |
| ------------------------ | -------------------------- |
| `POST /api/auth/login`   | Đăng nhập dashboard        |
| `GET/POST /api/accounts` | Quản lý tài khoản DeepSeek |
| `GET/POST /api/api-keys` | Quản lý API key            |
| `GET /api/logs`          | Xem log request            |
| `GET/PUT /api/settings`  | Cấu hình hệ thống          |

### Khác

| Endpoint             | Mô tả              |
| -------------------- | ------------------ |
| `GET /health`        | Health check       |
| `GET /api/stats`     | Thống kê tổng quan |
| `GET /api/analytics` | Dữ liệu analytics  |

## Cấu trúc thư mục

```
src/
├── index.ts                     # Entry point
├── app/
│   ├── database.ts              # SQLite + migrations
│   ├── server.ts                # Express setup
│   ├── middleware/
│   │   ├── auth.ts              # Bearer token auth
│   │   ├── logger.ts            # Request logging
│   │   └── rateLimit.ts         # Rate limiting
│   ├── routes/
│   │   ├── api.ts               # /v1/chat/completions
│   │   ├── management.ts        # /api/accounts, /api/api-keys, ...
│   │   ├── stats.ts             # /api/stats/*
│   │   └── analytics.ts         # /api/analytics/*
│   ├── models/
│   │   ├── account.ts           # DeepSeek account CRUD
│   │   ├── apiKey.ts            # API key CRUD
│   │   ├── conversation.ts      # Hash cache persistence
│   │   └── log.ts               # Request log persistence
│   └── services/
│       ├── analyticsService.ts  # Analytics queries
│       ├── modelService.ts      # Model mapping
│       ├── settingsService.ts   # Key-value settings
│       └── statsService.ts      # Stats queries
├── adapters/
│   └── openai/                  # OpenAI <-> Internal format
├── providers/
│   ├── core/
│   │   ├── manager.ts           # Session, cache, account orchestration
│   │   ├── hash.ts              # Message hashing & hash cache
│   │   ├── tool_parser.ts       # XML tool call parser
│   │   ├── tool_prompt.ts       # Tool system prompt builder
│   │   └── tool_sieve.ts        # Stream tool call extraction
│   └── deepseek/
│       ├── index.ts             # DeepSeekProvider
│       ├── client.ts            # API client (login, session, PoW, completion)
│       ├── models.ts            # Provider model definitions
│       ├── types.ts             # API types & constants
│       └── pow_native.ts        # WASM PoW initializer
├── types/
│   ├── adapter.ts
│   ├── common.ts
│   └── provider.ts
└── tests/                       # Test files
ui/
├── index.html
├── vite.config.ts
└── src/
    ├── App.tsx                  # App shell + routing
    ├── main.tsx                 # Entry point
    ├── pages/
    │   ├── Login.tsx            # Dashboard login
    │   ├── Providers.tsx        # Account management
    │   ├── ApiKeys.tsx          # API key management
    │   ├── Analysis.tsx         # Analytics dashboard
    │   ├── Logs.tsx             # Request log viewer
    │   └── Settings.tsx         # Settings + model maps
    └── components/
        ├── Layout.tsx           # App layout + sidebar
        ├── AccountModal.tsx     # Add/edit account
        ├── ApiKeyModal.tsx      # Add/edit API key
        ├── charts/              # Recharts components
        └── ui/                  # Radix UI wrappers
```

## License

MIT
