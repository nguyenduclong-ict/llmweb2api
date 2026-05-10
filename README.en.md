# llmweb2api

Turn web chat accounts (DeepSeek, Qwen, ChatGPT) into an OpenAI / Anthropic / Gemini-compatible API.

## Purpose

Many AI platforms offer free chat interfaces but no public API. This project acts as a proxy, allowing coding tools (OpenCode, Cursor, Continue, etc.) to use web accounts as a backend:

```
Coding Agent (OpenAI / Anthropic / Gemini API)
        │
        ▼
  llmweb2api (port 3000)
  - Multi-adapter: OpenAI, Anthropic, Gemini
  - Multi-provider: DeepSeek, Qwen, ChatGPT
  - Session management, hash cache, tool calling
        │
        ▼
  Chat Web API (chat.deepseek.com / chat.qwen.ai / chatgpt.com)
  - Real chat via user accounts
```

All you need is an account on the corresponding platform (email + password or token). The server handles login, session creation, and translates requests/responses back and forth.

## Tech Stack

| Component       | Stack                                                    |
| --------------- | -------------------------------------------------------- |
| Backend         | Node.js, TypeScript, Express                             |
| Database        | SQLite (better-sqlite3)                                  |
| Frontend        | React 19, Vite 6, Tailwind CSS v4, Radix UI, Recharts    |
| PoW (DeepSeek)  | Go WASM (fast) + JS fallback (slower)                    |
| Monorepo        | pnpm workspace (`packages/backend` + `packages/web`)     |

## Installation

Requirements: **Node.js >= 22**, **pnpm >= 9**

```bash
# Clone repository
git clone <repo-url>
cd llmweb2api

# Install dependencies
pnpm install
```

> The `postinstall` script builds Go WASM for Proof-of-Work (DeepSeek). If Go is not installed, the script prints a warning and falls back to a JS implementation — slower but functional.

## Docker

```bash
docker compose up -d
```

The server runs at `http://localhost:3567`.

## Configuration

Create a `.env` file from the template:

```bash
cp .env.example .env
```

| Variable             | Default         | Description                  |
| -------------------- | --------------- | ---------------------------- |
| `PORT`               | `3000`          | Server port                  |
| `HOST`               | `0.0.0.0`       | Bind address                 |
| `DASHBOARD_PASSWORD` | `admin123`      | Dashboard login password     |
| `DB_PATH`            | `./data/app.db` | SQLite database file path    |

Accounts are managed through the Dashboard — no need to put credentials in `.env`.

## Running

### Development (backend + frontend, auto-reload)

```bash
pnpm dev
```

- Backend: `http://localhost:3000`
- Frontend: `http://localhost:5173` (proxies `/api` → `:3000`)

### Production

```bash
pnpm build
pnpm start
```

The server runs at `http://localhost:3000`, serving both the API and dashboard UI from a single port.

## Initial Setup

1. **Log into the dashboard**: Open `http://localhost:3000`, log in with the password set in `DASHBOARD_PASSWORD`.

2. **Add an account**: Go to the **Providers** tab → **Add Account** → Choose provider (`deepseek`, `qwen`, `chatgpt`) and enter credentials.
   - DeepSeek: email + password
   - Qwen: token (from your Qwen account)
   - ChatGPT: under development

3. **Create an API Key**: Go to the **API Keys** tab → **Create New API Key**. **Enable cache** is on by default to optimize token usage.

4. **Use with OpenCode**: Add the provider to `~/.config/opencode/opencode.json`:

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

> Replace `sk-your-key-here` with the API key from step 3. If the server runs on a different machine or port, update `baseURL` accordingly.

## Key Features

- **Multi-provider**: DeepSeek (web chat), Qwen (API token), ChatGPT (under development).
- **Multi-adapter**: OpenAI-compatible (`/v1`), Anthropic (`/v1/messages`), Gemini (`/v1beta/models/*:generateContent`).
- **Hash-based cache**: Only new messages are sent to providers. Reverts and edits are handled intelligently via `parent_message_id`.
- **Reasoning / Thinking**: Supports DeepSeek and Qwen with thinking enabled.
- **Large prompts**: Prompts over 100KB are uploaded as file attachments.
- **Model mapping**: Flexible model name routing (e.g. `gpt-4o` → `deepseek-v4-flash`, `claude-sonnet-4-6` → `deepseek-v4-flash`).
- **Multi-account**: Supports multiple accounts, randomly selecting from enabled ones.
- **Analytics**: Dashboard with KPI cards, request volume charts, status code distribution, latency charts, and token usage.
- **Auto-cleanup**: Periodically prunes old logs and conversations based on `last_used` (only deletes when inactive for the configured period).

## API Endpoints

### LLM

| Endpoint                              | Format    |
| ------------------------------------- | --------- |
| `POST /v1/chat/completions`           | OpenAI    |
| `POST /v1/responses`                  | OpenAI    |
| `POST /v1/messages`                   | Anthropic |
| `POST /v1beta/models/*:generateContent` | Gemini  |
| `POST /v1beta/models/*:streamGenerateContent` | Gemini |

### Management

| Endpoint                   | Description                    |
| -------------------------- | ------------------------------ |
| `POST /api/auth/login`     | Dashboard login                |
| `GET/POST /api/accounts`   | Manage provider accounts       |
| `PUT/DELETE /api/accounts/:id` | Edit / delete account       |
| `GET/POST /api/api-keys`   | Manage API keys                |
| `PUT/DELETE /api/api-keys/:id` | Edit / delete API key       |
| `GET /api/logs`            | View request logs              |
| `GET/PUT /api/settings`    | System configuration           |

### Other

| Endpoint             | Description       |
| -------------------- | ----------------- |
| `GET /health`        | Health check      |
| `GET /api/stats`     | Usage summary     |
| `GET /api/analytics` | Analytics payload |

## Directory Structure

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
