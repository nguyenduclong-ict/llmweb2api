import { prepareAndAll, prepareAndGet, prepareAndRun } from '../database';

export interface LogRecord {
  id: string;
  api_key_id: number | null;
  provider_item_id: number | null;
  endpoint: string;
  method: string;
  status: number;
  stream: number;
  input_tokens: number;
  output_tokens: number;
  request_data: string | null;
  response_data: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface LogQueryParams {
  limit?: number;
  offset?: number;
  apiKeyId?: string;
  endpoint?: string;
  status?: number;
  startDate?: string;
  endDate?: string;
}

export function queryLogs(params: LogQueryParams): { logs: LogRecord[]; total: number } {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.apiKeyId) {
    conditions.push('api_key_id = ?');
    values.push(params.apiKeyId);
  }
  if (params.endpoint) {
    conditions.push('endpoint = ?');
    values.push(params.endpoint);
  }
  if (params.status !== undefined) {
    conditions.push('status = ?');
    values.push(params.status);
  }
  if (params.startDate) {
    conditions.push('created_at >= ?');
    values.push(params.startDate);
  }
  if (params.endDate) {
    conditions.push('created_at <= ?');
    values.push(params.endDate);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;

  const countRow = prepareAndGet<{ count: number }>(`SELECT COUNT(*) as count FROM request_logs ${where}`, values);
  const total = countRow?.count ?? 0;
  const logs = prepareAndAll<LogRecord>(
    `SELECT * FROM request_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...values, limit, offset],
  );

  return { logs, total };
}

export function deleteOldLogs(retentionDays: number): number {
  const before = prepareAndGet<{ count: number }>('SELECT COUNT(*) as count FROM request_logs');
  prepareAndRun(`DELETE FROM request_logs WHERE created_at < datetime('now', '-' || ? || ' days')`, [retentionDays]);
  const after = prepareAndGet<{ count: number }>('SELECT COUNT(*) as count FROM request_logs');
  return (before?.count ?? 0) - (after?.count ?? 0);
}
