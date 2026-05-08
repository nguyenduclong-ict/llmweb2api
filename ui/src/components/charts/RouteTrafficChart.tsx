import { useState, useEffect } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { apiGet } from '../../api/client';
import CustomChartTooltip from './CustomChartTooltip';

interface RouteTrafficPoint {
  time: string;
  [route: string]: number | string;
}

const DEFAULT_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#8b5cf6', '#6b7280', '#ef4444', '#6366f1', '#14b8a6'];

export default function RouteTrafficChart() {
  const [data, setData] = useState<RouteTrafficPoint[]>([]);
  const [routeKeys, setRouteKeys] = useState<string[]>([]);

  useEffect(() => {
    apiGet<RouteTrafficPoint[]>('/api/stats/request-volume')
      .then((res) => {
        // API trả về dữ liệu request volume có sẵn, ta dùng chính nó cho stacked area
        setData(res);
        if (res.length > 0) {
          const keys = Object.keys(res[0]).filter((k) => k !== 'time' && k !== 'DELETE');
          setRouteKeys(keys);
        }
      })
      .catch(() => setData([]));
  }, []);

  return (
    <ResponsiveContainer width="100%" height={350}>
      <AreaChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
        <XAxis dataKey="time" tick={{ fontSize: 12 }} interval={Math.max(0, Math.floor(data.length / 8) - 1)} />
        <YAxis tick={{ fontSize: 12 }} />
        <Tooltip content={<CustomChartTooltip />} />
        <Legend />
        {routeKeys.map((key, index) => (
          <Area
            key={key}
            type="monotone"
            dataKey={key}
            stackId="1"
            stroke={DEFAULT_COLORS[index % DEFAULT_COLORS.length]}
            fill={DEFAULT_COLORS[index % DEFAULT_COLORS.length]}
            fillOpacity={0.25}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}
