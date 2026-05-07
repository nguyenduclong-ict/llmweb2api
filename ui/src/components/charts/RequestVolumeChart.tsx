import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { requestVolumeData } from "../../data/mockData";

const COLORS = {
  GET: "#3b82f6",
  POST: "#22c55e",
  PUT: "#f59e0b",
  DELETE: "#ef4444",
};

export default function RequestVolumeChart() {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={requestVolumeData}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
        <XAxis
          dataKey="time"
          stroke="#9ca3af"
          tick={{ fontSize: 11 }}
          interval={11}
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
        <Line type="monotone" dataKey="GET" stroke={COLORS.GET} strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="POST" stroke={COLORS.POST} strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="PUT" stroke={COLORS.PUT} strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="DELETE" stroke={COLORS.DELETE} strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
