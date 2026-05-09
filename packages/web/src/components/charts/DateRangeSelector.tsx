import { Calendar } from 'lucide-react';
import { Button } from '../ui/button';
import type { DateRangePreset } from './dateRangeUtils';

const PRESETS: { value: DateRangePreset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'thisWeek', label: 'This Week' },
  { value: 'thisMonth', label: 'This Month' },
  { value: 'last7days', label: 'Last 7 Days' },
  { value: 'last30days', label: 'Last 30 Days' },
];

interface DateRangeSelectorProps {
  value: DateRangePreset;
  onChange: (preset: DateRangePreset) => void;
}

export default function DateRangeSelector({ value, onChange }: DateRangeSelectorProps) {
  return (
    <div className="flex items-center gap-2">
      <Calendar className="h-4 w-4 text-muted-foreground" />
      <div className="flex gap-1 flex-wrap">
        {PRESETS.map((p) => (
          <Button
            key={p.value}
            variant={value === p.value ? 'default' : 'outline'}
            size="sm"
            onClick={() => onChange(p.value)}
          >
            {p.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
