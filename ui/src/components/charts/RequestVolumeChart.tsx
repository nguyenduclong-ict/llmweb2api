import { useState, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { apiGet } from '../../api/client';
import CustomChartTooltip from './CustomChartTooltip';

interface RequestVolumePoint {
  time: string;
  GET: number;
  POST: number;
  PUT: number;
  DELETE: number;
}

interface Props {
  startDate?: string;
  endDate?: string;
  granularity?: 'hour' | 'day' | 'week' | 'month';
}

export default function RequestVolumeChart({ startDate, endDate, granularity }: Props) {
  const [data, setData] = useState<RequestVolumePoint[]>([]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);
    if (granularity) params.set('granularity', granularity);
    apiGet<RequestVolumePoint[]>(`/api/stats/request-volume?${params.toString()}`)
      .then(setData)
      .catch(() => setData([]));
  }, [startDate, endDate, granularity]);

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
        <XAxis dataKey="time" tick={{ fontSize: 12 }} interval={Math.max(0, Math.floor(data.length / 8) - 1)} />
        <YAxis tick={{ fontSize: 12 }} />
        <Tooltip content={<CustomChartTooltip />} />
        <Legend />
        <Line type="monotone" dataKey="GET" stroke="#3b82f6" strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="POST" stroke="#22c55e" strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="PUT" stroke="#f59e0b" strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="DELETE" stroke="#ef4444" strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
