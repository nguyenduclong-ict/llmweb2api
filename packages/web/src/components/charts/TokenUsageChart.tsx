import { useState, useEffect, useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { apiGet } from '../../api/client';
import CustomChartTooltip from './CustomChartTooltip';

interface TokenUsagePoint {
  date: string;
  inputTokens: number;
  outputTokens: number;
}

interface Props {
  startDate?: string;
  endDate?: string;
  granularity?: 'hour' | 'day' | 'week' | 'month';
}

function formatTick(value: string, granularity?: string): string {
  if (granularity === 'hour') {
    return value.length >= 16 ? value.slice(11, 16) : value;
  }
  if (granularity === 'week') {
    const parts = value.split('-W');
    if (parts.length === 2) return 'W' + parts[1];
    return value;
  }
  if (granularity === 'month') {
    return value.length >= 7 ? value.slice(0, 7) : value;
  }
  return value;
}

export default function TokenUsageChart({ startDate, endDate, granularity }: Props) {
  const [data, setData] = useState<TokenUsagePoint[]>([]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);
    if (granularity) params.set('granularity', granularity);
    apiGet<TokenUsagePoint[]>('/api/stats/daily-tokens?' + params.toString())
      .then(setData)
      .catch(() => setData([]));
  }, [startDate, endDate, granularity]);

  const tickFormatter = useMemo(() => (value: string) => formatTick(value, granularity), [granularity]);

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 12 }}
          interval={Math.max(0, Math.floor(data.length / 8) - 1)}
          tickFormatter={tickFormatter}
        />
        <YAxis tick={{ fontSize: 12 }} />
        <Tooltip content={<CustomChartTooltip />} />
        <Legend />
        <Line type="monotone" dataKey="inputTokens" name="Input Tokens" stroke="#8b5cf6" strokeWidth={2} dot={false} />
        <Line
          type="monotone"
          dataKey="outputTokens"
          name="Output Tokens"
          stroke="#ec4899"
          strokeWidth={2}
          dot={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
