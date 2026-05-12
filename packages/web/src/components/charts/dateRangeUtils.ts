import { startOfWeek, startOfMonth, format, subDays } from 'date-fns';

export type DateRangePreset =
  | 'today'
  | 'yesterday'
  | 'thisWeek'
  | 'thisMonth'
  | 'last3days'
  | 'last7days'
  | 'last30days'
  | 'custom';

export interface DateRange {
  preset: DateRangePreset;
  startDate: string;
  endDate: string;
}

function formatDate(d: Date): string {
  return format(d, 'yyyy-MM-dd');
}

function toEndOfDay(d: Date): string {
  return format(d, 'yyyy-MM-dd') + 'T23:59:59';
}

export function getDateRange(preset: DateRangePreset): DateRange {
  const now = new Date();
  switch (preset) {
    case 'today':
      return {
        preset,
        startDate: formatDate(now),
        endDate: toEndOfDay(now),
      };
    case 'yesterday': {
      const d = subDays(now, 1);
      return {
        preset,
        startDate: formatDate(d),
        endDate: toEndOfDay(d),
      };
    }
    case 'thisWeek':
      return {
        preset,
        startDate: formatDate(startOfWeek(now, { weekStartsOn: 1 })),
        endDate: toEndOfDay(now),
      };
    case 'thisMonth':
      return {
        preset,
        startDate: formatDate(startOfMonth(now)),
        endDate: toEndOfDay(now),
      };
    case 'last3days':
      return {
        preset,
        startDate: formatDate(subDays(now, 3)),
        endDate: toEndOfDay(now),
      };
    case 'last7days':
      return {
        preset,
        startDate: formatDate(subDays(now, 7)),
        endDate: toEndOfDay(now),
      };
    case 'last30days':
      return {
        preset,
        startDate: formatDate(subDays(now, 30)),
        endDate: toEndOfDay(now),
      };
    default:
      return {
        preset: 'today',
        startDate: formatDate(now),
        endDate: toEndOfDay(now),
      };
  }
}

export function getGranularityForRange(preset: DateRangePreset): 'hour' | 'day' | 'week' | 'month' {
  switch (preset) {
    case 'today':
    case 'yesterday':
      return 'hour';
    case 'thisWeek':
    case 'last3days':
    case 'last7days':
      return 'day';
    case 'thisMonth':
    case 'last30days':
      return 'day';
    default:
      return 'day';
  }
}
