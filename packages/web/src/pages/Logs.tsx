import { useEffect, useState } from 'react';
import { apiGet } from '../api/client';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Button } from '../components/ui/button';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface LogRecord {
  id: string;
  api_key_id: number | null;
  account_id: string | null;
  endpoint: string;
  method: string;
  status: number;
  stream: number;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number | null;
  created_at: string;
}

interface LogResponse {
  logs: LogRecord[];
  total: number;
}

export default function Logs() {
  const [data, setData] = useState<LogResponse>({ logs: [], total: 0 });
  const [page, setPage] = useState(0);
  const pageSize = 20;

  useEffect(() => {
    apiGet<LogResponse>(`/api/logs?limit=${pageSize}&offset=${page * pageSize}`)
      .then(setData)
      .catch(console.error);
  }, [page]);

  const totalPages = Math.ceil(data.total / pageSize);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Request Logs</h1>
        <p className="text-muted-foreground">View all API requests and responses</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Logs</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Endpoint</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Stream</TableHead>
                <TableHead>Tokens In</TableHead>
                <TableHead>Tokens Out</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>TPS</TableHead>
                <TableHead>API Key</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.logs.map((log) => (
                <TableRow key={log.id}>
                  <TableCell className="whitespace-nowrap text-sm">
                    {new Date(log.created_at + 'Z').toLocaleString()}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{log.endpoint}</TableCell>
                  <TableCell>{log.method}</TableCell>
                  <TableCell>
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium ${
                        log.status < 400 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                      }`}
                    >
                      {log.status}
                    </span>
                  </TableCell>
                  <TableCell>{log.stream ? 'Yes' : 'No'}</TableCell>
                  <TableCell>{log.input_tokens.toLocaleString()}</TableCell>
                  <TableCell>{log.output_tokens.toLocaleString()}</TableCell>
                  <TableCell>{log.duration_ms ? `${log.duration_ms}ms` : '-'}</TableCell>
                  <TableCell>
                    {log.duration_ms && log.duration_ms > 0
                      ? (log.output_tokens / (log.duration_ms / 1000)).toFixed(1)
                      : '-'}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {log.api_key_id ? `${String(log.api_key_id).slice(0, 8)}...` : '-'}
                  </TableCell>
                </TableRow>
              ))}
              {data.logs.length === 0 && (
                <TableRow>
                  <TableCell colSpan={10} className="text-center text-muted-foreground">
                    No logs yet
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>

          {data.total > 0 && (
            <div className="flex items-center justify-between mt-4">
              <div className="text-sm text-muted-foreground">
                Showing {page * pageSize + 1} to {Math.min((page + 1) * pageSize, data.total)} of {data.total} results
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setPage((p) => p - 1)} disabled={page === 0}>
                  <ChevronLeft className="h-4 w-4" />
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => p + 1)}
                  disabled={page + 1 >= totalPages}
                >
                  Next
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
