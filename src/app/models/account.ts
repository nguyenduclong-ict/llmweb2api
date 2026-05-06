import { prepareAndAll, prepareAndGet, prepareAndRun } from '../database';

export interface AccountRecord {
  id: number;
  name: string;
  provider: string;
  settings: string;
  session: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface CreateAccountInput {
  name: string;
  provider: string;
  settings?: Record<string, unknown>;
  session?: Record<string, unknown>;
}

export interface UpdateAccountInput {
  name?: string;
  provider?: string;
  settings?: Record<string, unknown>;
  session?: Record<string, unknown>;
  enabled?: number;
}

export function getAll(): AccountRecord[] {
  return prepareAndAll<AccountRecord>('SELECT * FROM accounts ORDER BY created_at DESC');
}

export function getById(id: number): AccountRecord | undefined {
  return prepareAndGet<AccountRecord>('SELECT * FROM accounts WHERE id = ?', [id]);
}

export function getByProvider(provider: string): AccountRecord[] {
  return prepareAndAll<AccountRecord>('SELECT * FROM accounts WHERE provider = ? ORDER BY created_at DESC', [provider]);
}

export function create(input: CreateAccountInput): AccountRecord {
  prepareAndRun('INSERT INTO accounts (name, provider, settings, session) VALUES (?, ?, ?, ?)', [
    input.name,
    input.provider,
    JSON.stringify(input.settings ?? {}),
    JSON.stringify(input.session ?? {}),
  ]);
  const row = prepareAndGet<AccountRecord>('SELECT * FROM accounts ORDER BY id DESC LIMIT 1');
  return row!;
}

export function update(id: number, input: UpdateAccountInput): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (input.name !== undefined) {
    fields.push('name = ?');
    values.push(input.name);
  }
  if (input.provider !== undefined) {
    fields.push('provider = ?');
    values.push(input.provider);
  }
  if (input.settings !== undefined) {
    fields.push('settings = ?');
    values.push(JSON.stringify(input.settings));
  }
  if (input.session !== undefined) {
    fields.push('session = ?');
    values.push(JSON.stringify(input.session));
  }
  if (input.enabled !== undefined) {
    fields.push('enabled = ?');
    values.push(input.enabled);
  }
  if (fields.length === 0) return;
  fields.push("updated_at = datetime('now')");
  values.push(id);
  prepareAndRun(`UPDATE accounts SET ${fields.join(', ')} WHERE id = ?`, values);
}

export function remove(id: number): void {
  prepareAndRun('DELETE FROM accounts WHERE id = ?', [id]);
}

export function findEnabledByProvider(providerName: string): AccountRecord | undefined {
  return prepareAndGet<AccountRecord>(
    'SELECT * FROM accounts WHERE provider = ? AND enabled = 1 ORDER BY RANDOM() LIMIT 1',
    [providerName],
  );
}
