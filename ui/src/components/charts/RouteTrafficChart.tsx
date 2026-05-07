import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { routeTrafficData } from "../../data/mockData";

const COLORS: Record<string, string> = {
  "User & Auth": "#3b82f6",
  Orders: "#22c55e",
  Products: "#f59e0b",
  Analytics: "#a855f7",
  Other: "#9ca3af",
};

export default function RouteTrafficChart() {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={routeTrafficData}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
        <XAxis
          dataKey="time"
          stroke="#9ca3af"
          tick={{ fontSize: 11 }}
          interval={7}
        />
        <YAxis stroke="#9ca3af" tick={{ fontSize: 11 }} />
        <Tooltip
          contentStyle={{
            backgroundColor: "#fff",
            border: "1px solid #e5e7eb",
            borderRadius: 8,
            fontSize: 12,
          }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {Object.entries(COLORS).map(([key, color]) => (
          <Area
            key={key}
            type="monotone"
            dataKey={key}
            stackId="1"
            stroke={color}
            fill={color}
            fillOpacity={0.3}
            strokeWidth={1.5}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}
