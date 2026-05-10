import { useState, useEffect, useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { apiGet } from '../../api/client';

interface RequestStatusPoint {
  time: string;
  total: number;
  errors: number;
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

export default function RequestStatusLineChart({ startDate, endDate, granularity }: Props) {
  const [data, setData] = useState<RequestStatusPoint[]>([]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);
    if (granularity) params.set('granularity', granularity);
    apiGet<RequestStatusPoint[]>('/api/stats/request-status-timeline?' + params.toString())
      .then(setData)
      .catch(() => setData([]));
  }, [startDate, endDate, granularity]);

  const tickFormatter = useMemo(() => (value: string) => formatTick(value, granularity), [granularity]);

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
        <XAxis
          dataKey="time"
          tick={{ fontSize: 12 }}
          interval={Math.max(0, Math.floor(data.length / 8) - 1)}
          tickFormatter={tickFormatter}
        />
        <YAxis tick={{ fontSize: 12 }} />
        <Tooltip
          content={({ active, payload }) => {
            if (active && payload && payload.length) {
              return (
                <div className="bg-popover border rounded-lg p-2 text-sm shadow-md">
                  {payload.map((entry) => (
                    <p key={entry.dataKey} className="text-muted-foreground">
                      {entry.dataKey === 'total' ? 'Total' : 'Errors'}: {entry.value}
                    </p>
                  ))}
                </div>
              );
            }
            return null;
          }}
        />
        <Legend />
        <Line type="monotone" dataKey="total" name="Total Requests" stroke="#3b82f6" strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="errors" name="Errors (4xx+5xx)" stroke="#ef4444" strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
