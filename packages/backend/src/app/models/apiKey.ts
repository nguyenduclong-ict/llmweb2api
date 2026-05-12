import { prepareAndAll, prepareAndGet, prepareAndRun } from '../database';
import crypto from 'crypto';

export interface ApiKeyRecord {
  id: number;
  key: string;
  name: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export function getAllApiKeys(): ApiKeyRecord[] {
  return prepareAndAll<ApiKeyRecord>(
    'SELECT id, key, name, enabled, created_at, updated_at FROM api_keys ORDER BY created_at DESC',
  );
}

export function getApiKeyById(id: number): ApiKeyRecord | undefined {
  return prepareAndGet<ApiKeyRecord>(
    'SELECT id, key, name, enabled, created_at, updated_at FROM api_keys WHERE id = ?',
    [id],
  );
}

export function getApiKeyByKey(key: string): ApiKeyRecord | undefined {
  return prepareAndGet<ApiKeyRecord>(
    'SELECT id, key, name, enabled, created_at, updated_at FROM api_keys WHERE key = ?',
    [key],
  );
}

export function generateKey(): string {
  return `sk-${crypto.randomBytes(24).toString('hex')}`;
}

export function createApiKey(name: string, apiKey?: string): ApiKeyRecord {
  const key = apiKey || generateKey();
  prepareAndRun('INSERT INTO api_keys (key, name) VALUES (?, ?)', [key, name]);
  const row = prepareAndGet<ApiKeyRecord>(
    'SELECT id, key, name, enabled, created_at, updated_at FROM api_keys ORDER BY id DESC LIMIT 1',
  );
  return row!;
}

export function updateApiKey(
  id: number,
  data: Partial<Pick<ApiKeyRecord, 'name'> & { enabled: boolean | number }>,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (data.name !== undefined) {
    fields.push('name = ?');
    values.push(data.name);
  }
  if (data.enabled !== undefined) {
    fields.push('enabled = ?');
    values.push(data.enabled ? 1 : 0);
  }
  if (fields.length === 0) return;
  fields.push("updated_at = datetime('now')");
  values.push(id);
  prepareAndRun(`UPDATE api_keys SET ${fields.join(', ')} WHERE id = ?`, values);
}

export function deleteApiKey(id: number): void {
  prepareAndRun('DELETE FROM api_keys WHERE id = ?', [id]);
}
