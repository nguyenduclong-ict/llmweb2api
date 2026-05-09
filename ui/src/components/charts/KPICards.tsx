import { useState, useEffect } from 'react';
import { apiGet } from '../../api/client';
import { Activity, Clock, AlertTriangle, Coins, TrendingUp, TrendingDown } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';

function formatNumber(num: number): string {
  if (num >= 1_000_000) return ${(num / 1_000_000).toFixed(1)}M;
  if (num >= 1_000) return ${(num / 1_000).toFixed(1)}K;
  return num.toString();
}

function TrendIndicator({ value, inverted = false }: { value: number; inverted?: boolean }) {
  const isUp = value >= 0;
  const isGood = inverted ? !isUp : isUp;
  const TrendIcon = isUp ? TrendingUp : TrendingDown;
  const colorClass = isGood ? 'text-green-500' : 'text-red-500';
  const prefix = isUp ? '+' : '';
  return (
    <span className={inline-flex items-center gap-0.5 text-xs font-medium }>
      <TrendIcon className='h-3 w-3' />
      {prefix}{value}%
    </span>
  );
}

interface KpiData {
  totalRequests: number;
  totalRequestsChange: number;
  p95Latency: number;
  p95LatencyChange: number;
  errorRate: number;
  errorRateChange: number;
  tokensUsed: number;
  tokensUsedChange: number;
}

interface Props {
  startDate?: string;
  endDate?: string;
}

const PLACEHOLDER_TITLES = ['Total Requests', 'P95 Latency', 'Error Rate', 'Tokens Used'];

export function KPICards({ startDate, endDate }: Props) {
  const [data, setData] = useState<KpiData | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams();
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);
    apiGet<KpiData>('/api/stats/kpi?' + params.toString())
      .then(setData)
      .catch(() => setError(true));
  }, [startDate, endDate]);

  if (error || !data) {
    return (
      <div className='grid gap-4 md:grid-cols-2 lg:grid-cols-4'>
        {PLACEHOLDER_TITLES.map((title) => (
          <Card key={title}>
            <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
              <CardTitle className='text-sm font-medium'>{title}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className='text-2xl font-bold text-muted-foreground'>--</div>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  const cards = [
    { title: 'Total Requests', value: formatNumber(data.totalRequests), subtitle: 'vs previous period', icon: Activity, color: 'text-blue-500', trend: data.totalRequestsChange, inverted: false },
    { title: 'P95 Latency', value: ${data.p95Latency} ms, subtitle: 'vs previous period', icon: Clock, color: 'text-amber-500', trend: data.p95LatencyChange, inverted: true },
    { title: 'Error Rate', value: ${data.errorRate}%, subtitle: 'vs previous period', icon: AlertTriangle, color: 'text-red-500', trend: data.errorRateChange, inverted: true },
    { title: 'Tokens Used', value: formatNumber(data.tokensUsed), subtitle: 'vs previous period', icon: Coins, color: 'text-purple-500', trend: data.tokensUsedChange, inverted: false },
  ];

  return (
    <div className='grid gap-4 md:grid-cols-2 lg:grid-cols-4'>
      {cards.map((card) => (
        <Card key={card.title} className='hover:shadow-md transition-shadow'>
          <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
            <CardTitle className='text-sm font-medium'>{card.title}</CardTitle>
            <card.icon className={h-4 w-4 } />
          </CardHeader>
          <CardContent>
            <div className='flex items-baseline gap-2'>
              <div className='text-2xl font-bold'>{card.value}</div>
              <TrendIndicator value={card.trend} inverted={card.inverted} />
            </div>
            <p className='text-xs text-muted-foreground mt-0.5'>{card.subtitle}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
