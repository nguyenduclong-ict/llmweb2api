import { prepareAndGet, prepareAndRun } from '../database';

export function getSetting(key: string, defaultValue?: string): string | undefined {
  const row = prepareAndGet<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
  return row?.value ?? defaultValue;
}

export function setSetting(key: string, value: string): void {
  prepareAndRun('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value]);
}
