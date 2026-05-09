# llmweb2api

Turn a DeepSeek Chat (web) account into an OpenAI-compatible API for use with **OpenCode**.

## Purpose

DeepSeek offers a free chat interface at [chat.deepseek.com](https://chat.deepseek.com) but provides no public API. This project acts as a proxy, allowing OpenCode (and other OpenAI API-compatible tools) to use DeepSeek web accounts as a backend:

```
OpenCode (OpenAI API)
        │
        ▼
  llmweb2api (port 3000)
  - OpenAI format
  - Session management, cache, tool calling
        │
        ▼
  DeepSeek Chat API (chat.deepseek.com)
  - Real chat via DeepSeek accounts
```

All you need is a DeepSeek account (email + password). The server handles login, Proof-of-Work challenges, session creation, and translating requests/responses between the OpenAI API and DeepSeek Chat API.

## Tech Stack

| Component      | Stack                                                 |
| -------------- | ----------------------------------------------------- |
| Backend        | Node.js, TypeScript, Express                          |
| Database       | SQLite (better-sqlite3)                               |
| Frontend       | React 19, Vite 6, Tailwind CSS v4, Radix UI, Recharts |
| PoW            | Go WASM (fast) + JS fallback (slower)                 |
| Package manager | pnpm                                                  |

## Installation

Requirements: **Node.js >= 18**, **pnpm**

```bash
# Clone repository
git clone <repo-url>
cd llmweb2api

# Install dependencies
pnpm install
```

> The `postinstall` script builds Go WASM for Proof-of-Work. If Go is not installed, the script prints a warning and falls back to a JS implementation — slower but functional.

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

DeepSeek accounts are managed through the Dashboard — no need to put credentials in `.env`.

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

### Backend only

```bash
npx tsx src/index.ts
```

## Initial Setup

1. **Log into the dashboard**: Open `http://localhost:3000`, log in with the password set in `DASHBOARD_PASSWORD`.

2. **Add a DeepSeek account**: Go to the **Providers** tab → **Add Account** → Enter the email + password for your DeepSeek account.

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

- **Conversation caching**: Hash-based message tracking — only new messages are sent to DeepSeek. Reverts and edits are handled intelligently via `edit_message`.
- **Reasoning / Thinking**: Supports deepseek-v4-pro with thinking enabled.
- **Large prompts**: Prompts over 100KB are uploaded as file attachments.
- **Model mapping**: Flexible model name routing (e.g. `gpt-4o` → `deepseek-v4-flash`).
- **Multi-account**: Supports multiple DeepSeek accounts, randomly selecting from enabled ones.
- **Analytics**: Dashboard with KPI cards, request volume charts, status code distribution, latency charts, and token usage.
- **Auto-cleanup**: Periodically prunes old logs and conversations based on retention settings.

## API Endpoints

### LLM

| Endpoint                    | Format   |
| --------------------------- | -------- |
| `POST /v1/chat/completions` | OpenAI   |
| `POST /v1/responses`        | OpenAI   |

### Management

| Endpoint                 | Description              |
| ------------------------ | ------------------------ |
| `POST /api/auth/login`   | Dashboard login          |
| `GET/POST /api/accounts` | Manage DeepSeek accounts |
| `GET/POST /api/api-keys` | Manage API keys          |
| `GET /api/logs`          | View request logs        |
| `GET/PUT /api/settings`  | System configuration     |

### Other

| Endpoint             | Description       |
| -------------------- | ----------------- |
| `GET /health`        | Health check      |
| `GET /api/stats`     | Usage summary     |
| `GET /api/analytics` | Analytics payload |

## Directory Structure

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
