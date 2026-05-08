import { useState, useMemo, useCallback } from 'react';
import { KPICards } from '../components/charts/KPICards';
import RequestStatusLineChart from '../components/charts/RequestStatusLineChart';
import TokenUsageChart from '../components/charts/TokenUsageChart';
import DateRangeSelector from '../components/charts/DateRangeSelector';
import { type DateRangePreset, getDateRange, getGranularityForRange } from '../components/charts/dateRangeUtils';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';

export default function Analysis() {
  const [preset, setPreset] = useState<DateRangePreset>('today');

  const handlePresetChange = useCallback((p: DateRangePreset) => {
    setPreset(p);
  }, []);

  const { startDate, endDate } = useMemo(() => getDateRange(preset), [preset]);
  const granularity = useMemo(() => getGranularityForRange(preset), [preset]);

  return (
    <div className='space-y-6'>
      <div className='flex items-center justify-between flex-wrap gap-4'>
        <div>
          <h1 className='text-3xl font-bold tracking-tight'>Analysis</h1>
          <p className='text-muted-foreground'>API performance, traffic, and system health overview</p>
        </div>
        <DateRangeSelector value={preset} onChange={handlePresetChange} />
      </div>

      <KPICards />

      <div className='grid gap-6 lg:grid-cols-2'>
        <Card>
          <CardHeader>
            <CardTitle>Requests and Errors Over Time</CardTitle>
          </CardHeader>
          <CardContent>
            <RequestStatusLineChart startDate={startDate} endDate={endDate} granularity={granularity} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Token Usage Over Time</CardTitle>
          </CardHeader>
          <CardContent>
            <TokenUsageChart startDate={startDate} endDate={endDate} granularity={granularity} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
