import { useEffect, useState } from 'react';
import { apiGet } from '../api/client';

interface LogRecord {
  id: string;
  api_key_id: string | null;
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

  return (
    <div>
      <div className="page-header">
        <h1>Request Logs</h1>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Endpoint</th>
              <th>Method</th>
              <th>Status</th>
              <th>Stream</th>
              <th>Tokens In</th>
              <th>Tokens Out</th>
              <th>Duration</th>
              <th>API Key</th>
            </tr>
          </thead>
          <tbody>
            {data.logs.map((log) => (
              <tr key={log.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{new Date(log.created_at).toLocaleString()}</td>
                <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>{log.endpoint}</td>
                <td>{log.method}</td>
                <td>
                  <span className={`status-badge ${log.status < 400 ? 'enabled' : 'disabled'}`}>{log.status}</span>
                </td>
                <td>{log.stream ? 'Yes' : 'No'}</td>
                <td>{log.input_tokens.toLocaleString()}</td>
                <td>{log.output_tokens.toLocaleString()}</td>
                <td>{log.duration_ms ? `${log.duration_ms}ms` : '-'}</td>
                <td style={{ fontFamily: 'monospace', fontSize: '11px' }}>
                  {log.api_key_id ? `${log.api_key_id.slice(0, 8)}...` : '-'}
                </td>
              </tr>
            ))}
            {data.logs.length === 0 && (
              <tr>
                <td colSpan={9} style={{ textAlign: 'center', color: '#999' }}>
                  No logs yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 16 }}>
        <button className="btn btn-secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
          Previous
        </button>
        <span style={{ padding: '8px 12px' }}>
          Page {page + 1} (Total: {data.total})
        </span>
        <button
          className="btn btn-secondary"
          disabled={(page + 1) * pageSize >= data.total}
          onClick={() => setPage((p) => p + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
