import { useState, useEffect } from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { apiGet } from '../../api/client';
import { CardFooter } from '../ui/card';

interface StatusCodeItem {
  code: number;
  label: string;
  count: number;
  color: string;
}

interface StatusCodeResponse {
  detailed: StatusCodeItem[];
  grouped: StatusCodeItem[];
  total: number;
}

export default function StatusCodePieChart() {
  const [grouped, setGrouped] = useState(false);
  const [statusData, setStatusData] = useState<StatusCodeResponse | null>(null);

  useEffect(() => {
    apiGet<StatusCodeResponse>('/api/stats/status-codes')
      .then(setStatusData)
      .catch(() => setStatusData(null));
  }, []);

  const data = statusData ? (grouped ? statusData.grouped : statusData.detailed) : [];

  const total = statusData?.total ?? 0;

  return (
    <>
      <div className="flex justify-end gap-1 mb-2">
        <button
          onClick={() => setGrouped(false)}
          className={`px-2 py-1 text-xs rounded ${!grouped ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
        >
          Detailed
        </button>
        <button
          onClick={() => setGrouped(true)}
          className={`px-2 py-1 text-xs rounded ${grouped ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
        >
          Grouped
        </button>
      </div>
      <ResponsiveContainer width="100%" height={240}>
        <PieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            innerRadius={55}
            outerRadius={90}
            paddingAngle={2}
            dataKey="count"
            nameKey="label"
          >
            {data.map((entry, index) => (
              <Cell key={index} fill={entry.color} />
            ))}
          </Pie>
          <Tooltip formatter={(value: number) => value.toLocaleString()} />
          <Legend />
        </PieChart>
      </ResponsiveContainer>
      <CardFooter className="justify-center pt-0">
        <span className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold bg-secondary text-secondary-foreground">
          Total: {total.toLocaleString()} requests
        </span>
      </CardFooter>
    </>
  );
}
