import initSqlJs from 'sql.js';
import type { Database as SqlJsDatabase, Statement } from 'sql.js';
import fs from 'fs';
import path from 'path';

let db: SqlJsDatabase;
let dbPath: string;

const LATEST_SCHEMA_VERSION = 3;

export async function initDatabase(customPath?: string): Promise<SqlJsDatabase> {
  dbPath = path.resolve(customPath || process.env.DB_PATH || './data/app.db');
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const SQL = await initSqlJs();

  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON');
  runMigrations();
  seedDefaultMappings();
  save();
  return db;
}

export function getDatabase(): SqlJsDatabase {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}

export function save(): void {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
}

export function prepareAndRun(sql: string, params?: any[]): void {
  db.run(sql, params);
  save();
}

export function prepareAndGet<T = Record<string, unknown>>(sql: string, params?: any[]): T | undefined {
  const stmt: Statement = db.prepare(sql);
  if (params) stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject() as unknown as T;
    stmt.free();
    return row;
  }
  stmt.free();
  return undefined;
}

export function prepareAndAll<T = Record<string, unknown>>(sql: string, params?: any[]): T[] {
  const results: T[] = [];
  const stmt: Statement = db.prepare(sql);
  if (params) stmt.bind(params);
  while (stmt.step()) {
    results.push(stmt.getAsObject() as unknown as T);
  }
  stmt.free();
  return results;
}

function getSchemaVersion(): number {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL DEFAULT 0
    )
  `);

  const stmt = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_version');
  let version = 0;
  if (stmt.step()) {
    version = (stmt.getAsObject() as { version: number }).version;
  }
  stmt.free();

  return version;
}

function setSchemaVersion(version: number): void {
  db.run('DELETE FROM schema_version');
  db.run('INSERT INTO schema_version (version) VALUES (?)', [version]);
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
      db.run(`
        CREATE TABLE IF NOT EXISTS accounts (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          name        TEXT NOT NULL,
          provider    TEXT NOT NULL,
          settings    TEXT NOT NULL DEFAULT '{}',
          session     TEXT NOT NULL DEFAULT '{}',
          enabled     INTEGER NOT NULL DEFAULT 1,
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(provider, name)
        )
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS api_keys (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          key         TEXT NOT NULL UNIQUE,
          name        TEXT NOT NULL,
          cache       INTEGER NOT NULL DEFAULT 0,
          enabled     INTEGER NOT NULL DEFAULT 1,
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      db.run(`
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
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS settings (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
    },
  },
  {
    version: 2,
    name: 'Add conversations table',
    run: () => {
      db.run(`
        CREATE TABLE IF NOT EXISTS conversations (
          conversation_id TEXT PRIMARY KEY,
          account_id     INTEGER REFERENCES accounts(id),
          provider       TEXT NOT NULL,
          messages       TEXT NOT NULL DEFAULT '[]',
          created_at     TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
    },
  },
  {
    version: 3,
    name: 'Rename provider_items to accounts, add session + account_id FK',
    run: () => {
      const hasProviderItems = checkTableExists('provider_items');
      const hasAccounts = checkTableExists('accounts');

      if (hasProviderItems && !hasAccounts) {
        db.run('ALTER TABLE provider_items RENAME TO accounts');
      } else if (hasProviderItems && hasAccounts) {
        db.run(
          'INSERT INTO accounts (name, provider, settings, enabled, created_at, updated_at) SELECT name, provider, settings, enabled, created_at, updated_at FROM provider_items',
        );
        db.run('DROP TABLE provider_items');
      }

      const accCols = getTableColumns('accounts');
      if (!accCols.includes('session')) {
        db.run("ALTER TABLE accounts ADD COLUMN session TEXT NOT NULL DEFAULT '{}'");
      }

      const logCols = getTableColumns('request_logs');
      if (logCols.includes('provider_item_id')) {
        db.run(`
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
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `);
        db.run(`
          INSERT INTO request_logs_new SELECT
            id, api_key_id, provider_item_id AS account_id,
            endpoint, method, status, stream,
            input_tokens, output_tokens, request_data, response_data, duration_ms, created_at
          FROM request_logs
        `);
        db.run('DROP TABLE request_logs');
        db.run('ALTER TABLE request_logs_new RENAME TO request_logs');
      }

      const convCols = getTableColumns('conversations');
      if (!convCols.includes('account_id')) {
        db.run(`
          CREATE TABLE conversations_new (
            conversation_id TEXT PRIMARY KEY,
            account_id     INTEGER REFERENCES accounts(id),
            provider       TEXT NOT NULL,
            messages       TEXT NOT NULL DEFAULT '[]',
            created_at     TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `);
        db.run(`
          INSERT INTO conversations_new SELECT
            conversation_id, NULL AS account_id, provider, messages, created_at, updated_at
          FROM conversations
        `);
        db.run('DROP TABLE conversations');
        db.run('ALTER TABLE conversations_new RENAME TO conversations');
      }
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
  const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?");
  stmt.bind([tableName]);
  const exists = stmt.step();
  stmt.free();
  return exists;
}

function getTableColumns(tableName: string): string[] {
  const stmt = db.prepare(`PRAGMA table_info(${tableName})`);
  const cols: string[] = [];
  while (stmt.step()) {
    cols.push(stmt.getAsObject().name as string);
  }
  stmt.free();
  return cols;
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
    const exists = db.prepare('SELECT value FROM settings WHERE key = ?');
    exists.bind([key]);
    if (!exists.step()) {
      db.run('INSERT INTO settings (key, value) VALUES (?, ?)', [key, value]);
    }
    exists.free();
  }
}

export function closeDatabase(): void {
  if (db) {
    save();
    db.close();
  }
}
