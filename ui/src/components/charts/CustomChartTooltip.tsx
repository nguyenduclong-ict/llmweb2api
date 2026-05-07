import React from "react";

interface TooltipEntry {
  name: string;
  value: number | string;
  color?: string;
  unit?: string;
}

interface CustomChartTooltipProps {
  active?: boolean;
  payload?: any[];
  label?: string;
  labelFormatter?: (label: string) => string;
  entries?: TooltipEntry[];
  customLabel?: string;
  /** Format number values automatically */
  numberFormat?: boolean;
  /** Show percentage share of each entry */
  showShare?: boolean;
}

function formatValue(value: number | string, numberFormat?: boolean): string {
  if (!numberFormat || typeof value !== "number") return String(value);
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

export default function CustomChartTooltip({
  active,
  payload,
  label,
  labelFormatter,
  showShare = false,
}: CustomChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;

  const total = showShare
    ? payload.reduce((sum: number, entry: any) => sum + (Number(entry.value) || 0), 0)
    : 0;

  const displayLabel = labelFormatter ? labelFormatter(label ?? "") : label;

  return (
    <div
      style={{
        backgroundColor: "#fff",
        border: "1px solid #e5e7eb",
        borderRadius: 8,
        padding: "10px 14px",
        fontSize: 12,
        boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
        minWidth: 140,
      }}
    >
      {displayLabel && (
        <p style={{ margin: "0 0 6px 0", fontWeight: 600, color: "#374151" }}>
          {displayLabel}
        </p>
      )}
      {payload.map((entry: any, index: number) => {
        const value = Number(entry.value) || 0;
        const sharePercent = total > 0 ? ((value / total) * 100).toFixed(1) : null;
        return (
          <div
            key={index}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 20,
              marginBottom: index < payload.length - 1 ? 3 : 0,
              minWidth: 160,
            }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  backgroundColor: entry.color ?? entry.fill ?? entry.stroke,
                  display: "inline-block",
                  flexShrink: 0,
                }}
              />
              <span style={{ color: "#6b7280", whiteSpace: "nowrap" }}>
                {entry.name}
              </span>
            </span>
            <span style={{ fontWeight: 600, color: "#111827", whiteSpace: "nowrap" }}>
              {entry.unit
                ? `${formatValue(value, true)} ${entry.unit}`
                : formatValue(value, true)}
              {sharePercent !== null && (
                <span style={{ fontSize: 10, color: "#9ca3af", marginLeft: 4 }}>
                  ({sharePercent}%)
                </span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
