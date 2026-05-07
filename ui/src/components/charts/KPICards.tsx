import { kpiData, formatNumber } from "../../data/mockData";
import { Activity, Clock, AlertTriangle, CheckCircle2, TrendingUp, TrendingDown } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

function TrendIndicator({
  value,
  /** Positive means good (e.g., uptime, total requests), negative means good (e.g., latency, errors) */
  inverted = false,
}: {
  value: number;
  inverted?: boolean;
}) {
  const isUp = value >= 0;
  const isGood = inverted ? !isUp : isUp;
  const TrendIcon = isUp ? TrendingUp : TrendingDown;
  const colorClass = isGood ? "text-green-500" : "text-red-500";
  const prefix = isUp ? "+" : "";

  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${colorClass}`}>
      <TrendIcon className="h-3 w-3" />
      {prefix}{value}%
    </span>
  );
}

export function KPICards() {
  const cards = [
    {
      title: "Total Requests",
      value: formatNumber(kpiData.totalRequests),
      subtitle: "vs yesterday",
      icon: Activity,
      color: "text-blue-500",
      trend: kpiData.totalRequestsChange,
      inverted: false,
    },
    {
      title: "P95 Latency",
      value: `${kpiData.p95Latency} ms`,
      subtitle: "vs yesterday",
      icon: Clock,
      color: "text-amber-500",
      trend: kpiData.p95LatencyChange,
      inverted: true,
    },
    {
      title: "Error Rate",
      value: `${kpiData.errorRate}%`,
      subtitle: "vs yesterday",
      icon: AlertTriangle,
      color: "text-red-500",
      trend: kpiData.errorRateChange,
      inverted: true,
    },
    {
      title: "Uptime",
      value: `${kpiData.uptime}%`,
      subtitle: "vs yesterday",
      icon: CheckCircle2,
      color: "text-green-500",
      trend: kpiData.uptimeChange,
      inverted: false,
    },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => (
        <Card key={card.title} className="hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{card.title}</CardTitle>
            <card.icon className={`h-4 w-4 ${card.color}`} />
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <div className="text-2xl font-bold">{card.value}</div>
              <TrendIndicator value={card.trend} inverted={card.inverted} />
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">{card.subtitle}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
