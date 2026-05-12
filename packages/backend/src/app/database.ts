import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

type DB = InstanceType<typeof Database>;

let db: DB;
let dbPath: string;

const LATEST_SCHEMA_VERSION = 10;

export async function initDatabase(customPath?: string): Promise<DB> {
  dbPath = path.resolve(customPath || process.env.DB_PATH || './data/app.db');
  console.log(`[DB] Initializing database at ${dbPath}`);
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  runMigrations();
  seedDefaultMappings();
  return db;
}

export function getDatabase(): DB {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}

export function prepareAndRun(sql: string, params?: unknown[]): void {
  db.prepare(sql).run(...(params || []));
}

export function prepareAndGet<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined {
  return db.prepare(sql).get(...(params || [])) as T | undefined;
}

export function prepareAndAll<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
  return db.prepare(sql).all(...(params || [])) as T[];
}

function getSchemaVersion(): number {
  db.prepare(
    `
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL DEFAULT 0
    )
  `,
  ).run();

  const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_version').get() as {
    version: number;
  };
  return row.version;
}

function setSchemaVersion(version: number): void {
  db.prepare('DELETE FROM schema_version').run();
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
}

interface Migration {
  version: number;
  name: string;
  run: () => void;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: 'Initial schema',
    run: () => {
      db.prepare(
        `
        CREATE TABLE IF NOT EXISTS accounts (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          name        TEXT NOT NULL,
          provider    TEXT NOT NULL,
          settings    TEXT NOT NULL DEFAULT '{}',
          session     TEXT NOT NULL DEFAULT '{}',
          enabled     INTEGER NOT NULL DEFAULT 1,
          created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
          updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
          UNIQUE(provider, name)
        )
      `,
      ).run();
      db.prepare(
        `
        CREATE TABLE IF NOT EXISTS api_keys (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          key         TEXT NOT NULL UNIQUE,
          name        TEXT NOT NULL,
          enabled     INTEGER NOT NULL DEFAULT 1,
          created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
          updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        )
      `,
      ).run();
      db.prepare(
        `
        CREATE TABLE IF NOT EXISTS request_logs (
          id          TEXT PRIMARY KEY,
          api_key_id  INTEGER REFERENCES api_keys(id),
          account_id  INTEGER REFERENCES accounts(id),
          endpoint    TEXT NOT NULL,
          method      TEXT NOT NULL,
          status      INTEGER NOT NULL,
          stream      INTEGER NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          request_data TEXT,
          response_data TEXT,
          duration_ms INTEGER,
          created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        )
      `,
      ).run();
      db.prepare(
        `
        CREATE TABLE IF NOT EXISTS settings (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `,
      ).run();
    },
  },
  {
    version: 2,
    name: 'Add conversations table',
    run: () => {
      db.prepare(
        `
        CREATE TABLE IF NOT EXISTS conversations (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id TEXT NOT NULL,
          seq             INTEGER NOT NULL DEFAULT 0,
          account_id     INTEGER REFERENCES accounts(id),
          provider       TEXT NOT NULL DEFAULT '',
          metadata       TEXT NOT NULL DEFAULT '{}',
          messages       TEXT NOT NULL DEFAULT '[]',
          tracked_count  INTEGER NOT NULL DEFAULT 0,
          tracked_hash   TEXT NOT NULL DEFAULT '',
          created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
          updated_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
          UNIQUE(conversation_id, seq)
        )
      `,
      ).run();
    },
  },
  {
    version: 3,
    name: 'Rename provider_items to accounts, add session + account_id FK',
    run: () => {
      const hasProviderItems = checkTableExists('provider_items');
      const hasAccounts = checkTableExists('accounts');

      if (hasProviderItems && !hasAccounts) {
        db.prepare('ALTER TABLE provider_items RENAME TO accounts').run();
      } else if (hasProviderItems && hasAccounts) {
        db.prepare(
          'INSERT INTO accounts (name, provider, settings, enabled, created_at, updated_at) SELECT name, provider, settings, enabled, created_at, updated_at FROM provider_items',
        ).run();
        db.prepare('DROP TABLE provider_items').run();
      }

      const accCols = getTableColumns('accounts');
      if (!accCols.includes('session')) {
        db.prepare("ALTER TABLE accounts ADD COLUMN session TEXT NOT NULL DEFAULT '{}'").run();
      }

      const logCols = getTableColumns('request_logs');
      if (logCols.includes('provider_item_id')) {
        db.prepare(
          `
          CREATE TABLE request_logs_new (
            id          TEXT PRIMARY KEY,
            api_key_id  INTEGER REFERENCES api_keys(id),
            account_id  INTEGER REFERENCES accounts(id),
            endpoint    TEXT NOT NULL,
            method      TEXT NOT NULL,
            status      INTEGER NOT NULL,
            stream      INTEGER NOT NULL DEFAULT 0,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            request_data TEXT,
            response_data TEXT,
            duration_ms INTEGER,
            created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
          )
        `,
        ).run();
        db.prepare(
          `
          INSERT INTO request_logs_new SELECT
            id, api_key_id, provider_item_id AS account_id,
            endpoint, method, status, stream,
            input_tokens, output_tokens, request_data, response_data, duration_ms, created_at
          FROM request_logs
        `,
        ).run();
        db.prepare('DROP TABLE request_logs').run();
        db.prepare('ALTER TABLE request_logs_new RENAME TO request_logs').run();
      }

      const convCols = getTableColumns('conversations');
      if (!convCols.includes('account_id')) {
        db.prepare(
          `
          CREATE TABLE conversations_new (
            conversation_id TEXT PRIMARY KEY,
            account_id     INTEGER REFERENCES accounts(id),
            provider       TEXT NOT NULL,
            messages       TEXT NOT NULL DEFAULT '[]',
            created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            updated_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
          )
        `,
        ).run();
        db.prepare(
          `
          INSERT INTO conversations_new SELECT
            conversation_id, NULL AS account_id, provider, messages, created_at, updated_at
          FROM conversations
        `,
        ).run();
        db.prepare('DROP TABLE conversations').run();
        db.prepare('ALTER TABLE conversations_new RENAME TO conversations').run();
      }
    },
  },
  {
    version: 4,
    name: 'Add token columns to conversations',
    run: () => {
      const cols = getTableColumns('conversations');
      if (!cols.includes('input_tokens')) {
        db.prepare('ALTER TABLE conversations ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0').run();
      }
      if (!cols.includes('output_tokens')) {
        db.prepare('ALTER TABLE conversations ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0').run();
      }
    },
  },
  {
    version: 5,
    name: 'Add tools_hash to conversations',
    run: () => {
      const cols = getTableColumns('conversations');
      if (!cols.includes('tools_hash')) {
        db.prepare("ALTER TABLE conversations ADD COLUMN tools_hash TEXT DEFAULT ''").run();
      }
    },
  },
  {
    version: 6,
    name: 'Add last_used to conversations',
    run: () => {
      const cols = getTableColumns('conversations');
      if (!cols.includes('last_used')) {
        db.prepare('ALTER TABLE conversations ADD COLUMN last_used TEXT').run();
        db.prepare('UPDATE conversations SET last_used = created_at WHERE last_used IS NULL').run();
      }
    },
  },
  {
    version: 7,
    name: 'Add last_message_id to conversations',
    run: () => {
      const cols = getTableColumns('conversations');
      if (!cols.includes('last_message_id')) {
        db.prepare('ALTER TABLE conversations ADD COLUMN last_message_id INTEGER').run();
      }
    },
  },
  {
    version: 8,
    name: 'Add prompt_cache_key to conversations',
    run: () => {
      const cols = getTableColumns('conversations');
      if (!cols.includes('prompt_cache_key')) {
        db.prepare("ALTER TABLE conversations ADD COLUMN prompt_cache_key TEXT DEFAULT ''").run();
        db.prepare('CREATE INDEX IF NOT EXISTS idx_conv_prompt_cache_key ON conversations(prompt_cache_key)').run();
      }
    },
  },
  {
    version: 9,
    name: 'Remove cache flag from API keys',
    run: () => {
      const cols = getTableColumns('api_keys');
      if (cols.includes('cache')) {
        db.prepare('ALTER TABLE api_keys DROP COLUMN cache').run();
      }
    },
  },
  {
    version: 10,
    name: 'Use sequenced conversation state metadata',
    run: () => {
      const cols = getTableColumns('conversations');
      if (cols.includes('seq') && cols.includes('metadata')) {
        db.prepare('CREATE INDEX IF NOT EXISTS idx_conv_latest ON conversations(conversation_id, seq DESC)').run();
        db.prepare('CREATE INDEX IF NOT EXISTS idx_conv_prompt_cache_key ON conversations(prompt_cache_key)').run();
        return;
      }

      db.prepare(
        `
        CREATE TABLE conversations_new (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id TEXT NOT NULL,
          seq             INTEGER NOT NULL DEFAULT 0,
          account_id     INTEGER REFERENCES accounts(id),
          provider       TEXT NOT NULL DEFAULT '',
          metadata       TEXT NOT NULL DEFAULT '{}',
          messages       TEXT NOT NULL DEFAULT '[]',
          tracked_count  INTEGER NOT NULL DEFAULT 0,
          tracked_hash   TEXT NOT NULL DEFAULT '',
          input_tokens   INTEGER NOT NULL DEFAULT 0,
          output_tokens  INTEGER NOT NULL DEFAULT 0,
          tools_hash     TEXT DEFAULT '',
          last_used      TEXT,
          last_message_id TEXT,
          prompt_cache_key TEXT DEFAULT '',
          created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
          updated_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
          UNIQUE(conversation_id, seq)
        )
      `,
      ).run();

      db.prepare(
        `
        INSERT INTO conversations_new (
          conversation_id, seq, account_id, provider, metadata, messages, tracked_count, tracked_hash,
          input_tokens, output_tokens, tools_hash, last_used, last_message_id, prompt_cache_key,
          created_at, updated_at
        )
        SELECT
          conversation_id,
          0,
          account_id,
          provider,
          json_object('providerSessionId', conversation_id),
          COALESCE(messages, '[]'),
          0,
          '',
          COALESCE(input_tokens, 0),
          COALESCE(output_tokens, 0),
          COALESCE(tools_hash, ''),
          COALESCE(last_used, created_at),
          last_message_id,
          COALESCE(prompt_cache_key, ''),
          created_at,
          updated_at
        FROM conversations
      `,
      ).run();

      db.prepare('DROP TABLE conversations').run();
      db.prepare('ALTER TABLE conversations_new RENAME TO conversations').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_conv_latest ON conversations(conversation_id, seq DESC)').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_conv_prompt_cache_key ON conversations(prompt_cache_key)').run();
    },
  },
];

function runMigrations(): void {
  const currentVersion = getSchemaVersion();
  const targetVersion = LATEST_SCHEMA_VERSION;

  if (currentVersion >= targetVersion) {
    console.log(`[DB] Schema version ${currentVersion} is up to date`);
    dumpTables();
    return;
  }

  console.log(`[DB] Migrating schema from version ${currentVersion} to ${targetVersion}`);

  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue;
    console.log(`[DB] Running migration v${migration.version}: ${migration.name}`);
    migration.run();
    setSchemaVersion(migration.version);
    console.log(`[DB] Migration v${migration.version} complete`);
  }

  console.log(`[DB] Schema migration finished at version ${targetVersion}`);
  dumpTables();
}

function dumpTables(): void {
  const tables = prepareAndAll<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  console.log(`[DB] Tables: ${tables.map((t) => t.name).join(', ')}`);
}

function checkTableExists(tableName: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(tableName);
  return !!row;
}

function getTableColumns(tableName: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function seedDefaultMappings(): void {
  const defaults: Record<string, string> = {
    model_map_openai: JSON.stringify({
      'gpt-4o': 'deepseek-v4-flash',
      'gpt-4o-mini': 'deepseek-v4-flash',
      'gpt-4-turbo': 'deepseek-v4-flash',
      'gpt-3.5-turbo': 'deepseek-v4-flash',
      'o1': 'deepseek-v4-pro',
      'o3': 'deepseek-v4-pro',
      'o3-mini': 'deepseek-v4-pro',
    }),
    model_map_anthropic: JSON.stringify({
      'claude-sonnet-4-6': 'deepseek-v4-flash',
      'claude-opus-4-6': 'deepseek-v4-pro',
      'claude-3-5-sonnet-20241022': 'deepseek-v4-flash',
      'claude-3-opus-20240229': 'deepseek-v4-pro',
      'claude-3-haiku-20240307': 'deepseek-v4-flash',
    }),
    model_map_gemini: JSON.stringify({
      'gemini-2.5-pro': 'deepseek-v4-pro',
      'gemini-2.5-flash': 'deepseek-v4-flash',
      'gemini-2.0-flash': 'deepseek-v4-flash',
      'gemini-1.5-pro': 'deepseek-v4-pro',
      'gemini-1.5-flash': 'deepseek-v4-flash',
      'gemini-pro': 'deepseek-v4-flash',
    }),
  };

  for (const [key, value] of Object.entries(defaults)) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
    }
  }
}

export function closeDatabase(): void {
  if (db) {
    db.close();
  }
}
