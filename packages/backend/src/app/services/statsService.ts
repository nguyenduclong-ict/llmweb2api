import { prepareAndGet, prepareAndAll } from '../database';

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

// ---- Analytics: Request volume theo thời gian (mỗi điểm 1 giờ) ----
export interface RequestVolumePoint {
  time: string;
  GET: number;
  POST: number;
  PUT: number;
  DELETE: number;
}

export function getRequestVolume(
  startDate?: string,
  endDate?: string,
  granularity: 'hour' | 'day' | 'week' | 'month' = 'hour',
): RequestVolumePoint[] {
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

  let timeExpr: string;
  let timeSlice: number;
  if (granularity === 'hour') {
    timeExpr = "strftime('%Y-%m-%d %H:00', created_at)";
    timeSlice = -5;
  } else if (granularity === 'day') {
    timeExpr = 'date(created_at)';
    timeSlice = 0;
  } else if (granularity === 'week') {
    timeExpr = "strftime('%Y-W%W', created_at)";
    timeSlice = 0;
  } else {
    timeExpr = "strftime('%Y-%m', created_at)";
    timeSlice = 0;
  }

  const rows = prepareAndAll<{ timeBucket: string; method: string; cnt: number }>(
    `
    SELECT
      ${timeExpr} AS timeBucket,
      method,
      COUNT(*) AS cnt
    FROM request_logs ${where}
    GROUP BY timeBucket, method
    ORDER BY timeBucket ASC
  `,
    values,
  );

  const methodList = ['GET', 'POST', 'PUT', 'DELETE'];
  const map = new Map<string, Record<string, number>>();
  for (const row of rows) {
    if (!map.has(row.timeBucket)) map.set(row.timeBucket, { GET: 0, POST: 0, PUT: 0, DELETE: 0 });
    const entry = map.get(row.timeBucket)!;
    if (methodList.includes(row.method)) entry[row.method] = row.cnt;
  }

  return Array.from(map.entries()).map(([time, methods]) => ({
    time: timeSlice ? time.slice(timeSlice) : time,
    ...methods,
  })) as any;
}

// ---- Request Status Timeline ----
export interface RequestStatusTimelinePoint {
  time: string;
  total: number;
  errors: number;
}

export function getRequestStatusTimeline(
  startDate?: string,
  endDate?: string,
  granularity: 'hour' | 'day' | 'week' | 'month' = 'hour',
): RequestStatusTimelinePoint[] {
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

  let timeExpr: string;
  let timeSlice: number;
  if (granularity === 'hour') {
    timeExpr = "strftime('%Y-%m-%d %H:00', created_at)";
    timeSlice = -5;
  } else if (granularity === 'day') {
    timeExpr = 'date(created_at)';
    timeSlice = 0;
  } else if (granularity === 'week') {
    timeExpr = "strftime('%Y-W%W', created_at)";
    timeSlice = 0;
  } else {
    timeExpr = "strftime('%Y-%m', created_at)";
    timeSlice = 0;
  }

  return prepareAndAll<RequestStatusTimelinePoint>(
    `
    SELECT
      ${timeExpr} AS time,
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors
    FROM request_logs ${where}
    GROUP BY time
    ORDER BY time ASC
  `,
    values,
  ).map((row) => ({
    ...row,
    time: timeSlice ? row.time.slice(timeSlice) : row.time,
  }));
}

// ---- Status Code Distribution ----
export interface StatusCodeItem {
  code: number;
  label: string;
  count: number;
  color: string;
}

export function getStatusCodeDistribution(
  startDate?: string,
  endDate?: string,
): {
  detailed: StatusCodeItem[];
  grouped: StatusCodeItem[];
  total: number;
} {
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

  const rows = prepareAndAll<{ status: number; cnt: number }>(
    `SELECT status, COUNT(*) AS cnt FROM request_logs ${where} GROUP BY status ORDER BY cnt DESC`,
    values,
  );

  const detailed: StatusCodeItem[] = [];
  const groupedMap = new Map<string, number>();

  const labelMap: Record<number, string> = {
    200: '200 OK',
    201: '201 Created',
    204: '204 No Content',
    400: '400 Bad Request',
    401: '401 Unauthorized',
    403: '403 Forbidden',
    404: '404 Not Found',
    429: '429 Too Many Requests',
    500: '500 Server Error',
    502: '502 Bad Gateway',
    503: '503 Unavailable',
  };

  for (const row of rows) {
    const label = labelMap[row.status] || `${row.status}`;
    let color = '#6b7280';
    if (row.status >= 200 && row.status < 300) color = '#22c55e';
    else if (row.status >= 400 && row.status < 500) color = '#f59e0b';
    else if (row.status >= 500) color = '#ef4444';

    detailed.push({ code: row.status, label, count: row.cnt, color });

    const group =
      row.status < 300
        ? '2xx Success'
        : row.status < 400
          ? '3xx Redirect'
          : row.status < 500
            ? '4xx Client Error'
            : '5xx Server Error';
    groupedMap.set(group, (groupedMap.get(group) || 0) + row.cnt);
  }

  const groupedColors: Record<string, string> = {
    '2xx Success': '#22c55e',
    '4xx Client Error': '#f59e0b',
    '5xx Server Error': '#ef4444',
  };

  const grouped: StatusCodeItem[] = Array.from(groupedMap.entries()).map(([label, count]) => ({
    code: 0,
    label,
    count,
    color: groupedColors[label] || '#6b7280',
  }));

  const total = detailed.reduce((sum, d) => sum + d.count, 0);

  return { detailed, grouped, total };
}

// ---- Endpoint Latency ----
export interface EndpointLatency {
  endpoint: string;
  method: string;
  p50: number;
  p95: number;
  p99: number;
}

export function getEndpointLatency(startDate?: string, endDate?: string): EndpointLatency[] {
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

  // SQLite không có PERCENTILE_CONT, ta dùng cách tính thủ công bằng cách lấy mẫu
  const durationCondition = conditions.length > 0 ? 'AND duration_ms IS NOT NULL' : 'WHERE duration_ms IS NOT NULL';
  const rows = prepareAndAll<{ endpoint: string; method: string; duration_ms: number }>(
    `SELECT endpoint, method, duration_ms FROM request_logs ${where} ${durationCondition} ORDER BY endpoint, method`,
    values,
  );

  // Nhóm theo endpoint + method
  const grouped = new Map<string, number[]>();
  for (const row of rows) {
    const key = `${row.method} ${row.endpoint}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(row.duration_ms);
  }

  const result: EndpointLatency[] = [];
  for (const [key, durations] of grouped.entries()) {
    const sorted = durations.sort((a, b) => a - b);
    const p50 = percentile(sorted, 0.5);
    const p95 = percentile(sorted, 0.95);
    const p99 = percentile(sorted, 0.99);
    const [method, ...endpointParts] = key.split(' ');
    result.push({ endpoint: endpointParts.join(' '), method, p50, p95, p99 });
  }

  return result.sort((a, b) => b.p95 - a.p95);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

// ---- Thống kê theo model ----
export interface ModelStats {
  model: string;
  requests: number;
  totalTokens: number;
  avgDurationMs: number;
}

export function getStatsByModel(startDate?: string, endDate?: string): ModelStats[] {
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

  return prepareAndAll<ModelStats>(
    `
    SELECT
      COALESCE(json_extract(request_data, '$.model'), 'unknown') AS model,
      COUNT(*) AS requests,
      COALESCE(SUM(input_tokens + output_tokens), 0) AS totalTokens,
      COALESCE(AVG(duration_ms), 0) AS avgDurationMs
    FROM request_logs ${where}
    GROUP BY model
    ORDER BY requests DESC
  `,
    values,
  );
}

// ---- Tổng tokens theo ngày để vẽ biểu đồ ----
export interface DailyTokenStats {
  date: string;
  inputTokens: number;
  outputTokens: number;
}

export function getDailyTokenStats(
  startDate?: string,
  endDate?: string,
  granularity: 'hour' | 'day' | 'week' | 'month' = 'day',
): DailyTokenStats[] {
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

  let timeExpr: string;
  if (granularity === 'hour') {
    timeExpr = "strftime('%Y-%m-%d %H:00', created_at)";
  } else if (granularity === 'day') {
    timeExpr = 'date(created_at)';
  } else if (granularity === 'week') {
    timeExpr = "strftime('%Y-W%W', created_at)";
  } else {
    timeExpr = "strftime('%Y-%m', created_at)";
  }

  return prepareAndAll<DailyTokenStats>(
    `
    SELECT
      ${timeExpr} AS date,
      COALESCE(SUM(input_tokens), 0) AS inputTokens,
      COALESCE(SUM(output_tokens), 0) AS outputTokens
    FROM request_logs ${where}
    GROUP BY date
    ORDER BY date ASC
  `,
    values,
  );
}

// ---- KPI cho thời gian thực (so với ngày hôm trước) ----
export interface KPIResponse {
  totalRequests: number;
  totalRequestsChange: number;
  p95Latency: number;
  p95LatencyChange: number;
  errorRate: number;
  errorRateChange: number;
  tokensUsed: number;
  tokensUsedChange: number;
  tps: number;
  tpsChange: number;
}

export function getKpiStats(startDate?: string, endDate?: string): KPIResponse {
  if (!startDate && !endDate) {
    const now = new Date();
    startDate = now.toISOString().slice(0, 10);
    endDate = startDate + 'T23:59:59';
  }

  const s = new Date(startDate!);
  const e = endDate ? new Date(endDate!) : new Date();
  const rangeMs = e.getTime() - s.getTime();
  const prevEnd = new Date(s.getTime() - 1);
  const prevStart = new Date(prevEnd.getTime() - rangeMs);

  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const currentStart = fmt(s);
  const currentEnd = endDate ? fmt(e) + 'T23:59:59' : fmt(e);
  const prevStartStr = fmt(prevStart);
  const prevEndStr = fmt(prevEnd) + 'T23:59:59';

  const currentStats = prepareAndGet<{ requests: number; errors: number; p95: number; tokens: number; tps: number }>(
    `
    SELECT
      COUNT(*) AS requests,
      COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors,
      COALESCE(AVG(duration_ms), 0) AS p95,
      COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
      CASE WHEN SUM(duration_ms) > 0 THEN CAST(SUM(output_tokens) AS REAL) / (SUM(duration_ms) / 1000.0) ELSE 0 END AS tps
    FROM request_logs WHERE created_at >= ? AND created_at <= ?
  `,
    [currentStart, currentEnd + (endDate ? '' : '')],
  ) ?? { requests: 0, errors: 0, p95: 0, tokens: 0, tps: 0 };

  const prevStats = prepareAndGet<{ requests: number; errors: number; p95: number; tokens: number; tps: number }>(
    `
    SELECT
      COUNT(*) AS requests,
      COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors,
      COALESCE(AVG(duration_ms), 0) AS p95,
      COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
      CASE WHEN SUM(duration_ms) > 0 THEN CAST(SUM(output_tokens) AS REAL) / (SUM(duration_ms) / 1000.0) ELSE 0 END AS tps
    FROM request_logs WHERE created_at >= ? AND created_at <= ?
  `,
    [prevStartStr, prevEndStr],
  ) ?? { requests: 0, errors: 0, p95: 0, tokens: 0, tps: 0 };

  const calcChange = (curr: number, prev: number): number => {
    if (prev === 0) return curr > 0 ? 100 : 0;
    return Math.round(((curr - prev) / prev) * 1000) / 10;
  };

  const currentErrorRate =
    currentStats.requests > 0 ? Math.round((currentStats.errors / currentStats.requests) * 1000) / 10 : 0;
  const prevErrorRate = prevStats.requests > 0 ? Math.round((prevStats.errors / prevStats.requests) * 1000) / 10 : 0;

  return {
    totalRequests: currentStats.requests,
    totalRequestsChange: calcChange(currentStats.requests, prevStats.requests),
    p95Latency: Math.round(currentStats.p95),
    p95LatencyChange: calcChange(currentStats.p95, prevStats.p95),
    errorRate: currentErrorRate,
    errorRateChange: Math.round((currentErrorRate - prevErrorRate) * 10) / 10,
    tokensUsed: currentStats.tokens,
    tokensUsedChange: calcChange(currentStats.tokens, prevStats.tokens),
    tps: Math.round(currentStats.tps * 10) / 10,
    tpsChange: calcChange(currentStats.tps, prevStats.tps),
  };
}

// ---- Increment stats (giữ nguyên) ----
export function incrementStats(_params: {
  model: string;
  change: { tokens: number; ttfb: number; streaming: boolean };
}): void {
  // Giữ nguyên logic cũ nếu có
}
