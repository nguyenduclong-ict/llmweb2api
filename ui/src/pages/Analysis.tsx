import { useEffect, useState } from 'react';
import { apiGet } from '../api/client';

interface StatsSummary {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgDurationMs: number;
}

export default function Analysis() {
  const [stats, setStats] = useState<StatsSummary | null>(null);

  useEffect(() => {
    apiGet<StatsSummary>('/api/stats').then(setStats).catch(console.error);
  }, []);

  if (!stats) return <div>Loading...</div>;

  return (
    <div>
      <div className="page-header">
        <h1>Analysis</h1>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-value">{stats.totalRequests.toLocaleString()}</div>
          <div className="stat-label">Total Requests</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats.totalInputTokens.toLocaleString()}</div>
          <div className="stat-label">Input Tokens</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats.totalOutputTokens.toLocaleString()}</div>
          <div className="stat-label">Output Tokens</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{Math.round(stats.avgDurationMs)}ms</div>
          <div className="stat-label">Avg Duration</div>
        </div>
      </div>

      <div className="card">
        <p style={{ color: '#888' }}>More detailed analytics will be available in Phase 2.</p>
      </div>
    </div>
  );
}
