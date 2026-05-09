import { useState, useEffect, useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { apiGet } from '../../api/client';

interface EndpointLatency {
  endpoint: string;
  method: string;
  p50: number;
  p95: number;
  p99: number;
}

export default function EndpointLatencyChart() {
  const [data, setData] = useState<EndpointLatency[]>([]);

  useEffect(() => {
    apiGet<EndpointLatency[]>('/api/stats/endpoint-latency')
      .then(setData)
      .catch(() => setData([]));
  }, []);

  const chartData = useMemo(
    () =>
      data.map((item) => ({
        name: `${item.method} ${item.endpoint}`,
        p50: item.p50,
        p95: item.p95,
        p99: item.p99,
      })),
    [data],
  );

  return (
    <ResponsiveContainer width="100%" height={400}>
      <BarChart data={chartData} layout="vertical" margin={{ left: 20 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
        <XAxis type="number" stroke="#9ca3af" tick={{ fontSize: 11 }} />
        <YAxis type="category" dataKey="name" stroke="#9ca3af" tick={{ fontSize: 10 }} width={180} />
        <Tooltip
          contentStyle={{
            backgroundColor: '#fff',
            border: '1px solid #e5e7eb',
            borderRadius: 8,
            fontSize: 12,
          }}
          formatter={(value: number) => `${value} ms`}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="p50" fill="#3b82f6" name="P50" radius={[0, 2, 2, 0]} />
        <Bar dataKey="p95" fill="#f59e0b" name="P95" radius={[0, 2, 2, 0]} />
        <Bar dataKey="p99" fill="#ef4444" name="P99" radius={[0, 2, 2, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
