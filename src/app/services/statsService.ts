import { prepareAndGet } from '../database';

export interface StatsSummary {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgDurationMs: number;
}

export function getStatsSummary(startDate?: string, endDate?: string): StatsSummary {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (startDate) {
    conditions.push('created_at >= ?');
    values.push(startDate);
  }
  if (endDate) {
    conditions.push('created_at <= ?');
    values.push(endDate);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const row = prepareAndGet<StatsSummary>(
    `
    SELECT
      COUNT(*) as totalRequests,
      COALESCE(SUM(input_tokens), 0) as totalInputTokens,
      COALESCE(SUM(output_tokens), 0) as totalOutputTokens,
      COALESCE(AVG(duration_ms), 0) as avgDurationMs
    FROM request_logs ${where}
  `,
    values,
  );

  return row ?? { totalRequests: 0, totalInputTokens: 0, totalOutputTokens: 0, avgDurationMs: 0 };
}
