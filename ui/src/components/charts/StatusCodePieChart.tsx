import { useState } from "react";
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from "recharts";
import {
  statusCodeData,
  groupedStatusCodeData,
  totalRequestCount,
  formatNumber,
} from "../../data/mockData";
import CustomChartTooltip from "./CustomChartTooltip";

type ViewMode = "detail" | "grouped";

export default function StatusCodePieChart() {
  const [viewMode, setViewMode] = useState<ViewMode>("detail");
  const data = viewMode === "detail" ? statusCodeData : groupedStatusCodeData;

  return (
    <div className="relative">
      {/* Toggle */}
      <div className="absolute top-0 right-0 z-10 flex rounded-md bg-muted p-0.5 text-xs">
        <button
          type="button"
          className={`px-2.5 py-1 rounded-sm transition-colors ${
            viewMode === "detail"
              ? "bg-white text-foreground shadow-sm font-medium"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setViewMode("detail")}
        >
          Detail
        </button>
        <button
          type="button"
          className={`px-2.5 py-1 rounded-sm transition-colors ${
            viewMode === "grouped"
              ? "bg-white text-foreground shadow-sm font-medium"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setViewMode("grouped")}
        >
          Grouped
        </button>
      </div>

      <ResponsiveContainer width="100%" height={300}>
        <PieChart>
          <Pie
            data={data}
            dataKey="count"
            nameKey="label"
            cx="50%"
            cy="50%"
            innerRadius={55}
            outerRadius={95}
            paddingAngle={2}
          >
            {data.map((entry, index) => (
              <Cell key={entry.label + index} fill={entry.color} />
            ))}
          </Pie>
          <Tooltip content={<CustomChartTooltip showShare />} />
          <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" />
          {/* Total in center */}
          <text
            x="50%"
            y="47%"
            textAnchor="middle"
            dominantBaseline="middle"
            style={{ fontSize: 20, fontWeight: 700, fill: "#111827" }}
          >
            {formatNumber(totalRequestCount)}
          </text>
          <text
            x="50%"
            y="54%"
            textAnchor="middle"
            dominantBaseline="middle"
            style={{ fontSize: 10, fill: "#9ca3af" }}
          >
            requests
          </text>
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
