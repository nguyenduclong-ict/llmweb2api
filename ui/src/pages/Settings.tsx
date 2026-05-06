import { useEffect, useState } from 'react';
import { apiGet, apiPut } from '../api/client';

interface AppSettings {
  dashboardPassword: string;
  logRetentionDays: string;
  conversationRetention: string;
  modelMaps: Record<string, Record<string, string>>;
  availableProviderModels: string[];
}

interface ModelMapsData {
  openai: Record<string, string>;
  anthropic: Record<string, string>;
  gemini: Record<string, string>;
  availableProviderModels: string[];
  defaults: Record<string, Record<string, string>>;
}

const ADAPTERS = [
  { key: 'openai', label: 'OpenAI' },
  { key: 'anthropic', label: 'Anthropic' },
  { key: 'gemini', label: 'Gemini' },
] as const;

export default function Settings() {
  const [, setSettings] = useState<AppSettings>({
    dashboardPassword: '',
    logRetentionDays: '30',
    conversationRetention: '',
    modelMaps: {},
    availableProviderModels: [],
  });
  const [password, setPassword] = useState('');
  const [retentionDays, setRetentionDays] = useState('30');
  const [conversationRetention, setConversationRetention] = useState('');
  const [saved, setSaved] = useState(false);

  const [modelMaps, setModelMaps] = useState<ModelMapsData>({
    openai: {},
    anthropic: {},
    gemini: {},
    availableProviderModels: [],
    defaults: {},
  });
  const [activeTab, setActiveTab] = useState<'openai' | 'anthropic' | 'gemini'>('openai');

  useEffect(() => {
    apiGet<AppSettings>('/api/settings')
      .then((data) => {
        setSettings(data);
        setRetentionDays(data.logRetentionDays);
        setConversationRetention(data.conversationRetention || '');
      })
      .catch(console.error);

    apiGet<ModelMapsData>('/api/settings/model-maps')
      .then((data) => {
        setModelMaps(data);
      })
      .catch(console.error);
  }, []);

  async function handleSaveSettings() {
    await apiPut('/api/settings', {
      dashboardPassword: password || undefined,
      logRetentionDays: retentionDays,
      conversationRetention,
    });
    if (password) {
      localStorage.setItem('dashboard_password', password);
      setPassword('');
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function handleSaveModelMaps(adapter: string) {
    await apiPut('/api/settings/model-maps', {
      [adapter]: (modelMaps as any)[adapter] || {},
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function handleMapChange(adapter: string, vendorModel: string, providerModel: string) {
    setModelMaps((prev) => ({
      ...prev,
      [adapter]: { ...((prev as any)[adapter] as Record<string, string>), [vendorModel]: providerModel },
    }));
  }

  function handleRemoveMapping(adapter: string, vendorModel: string) {
    setModelMaps((prev) => {
      const map = (prev as any)[adapter] as Record<string, string>;
      if (!map || typeof map !== 'object' || Array.isArray(map)) return prev;
      const copy: Record<string, string> = { ...map };
      delete copy[vendorModel];
      return { ...prev, [adapter]: copy };
    });
  }

  function handleAddMapping(adapter: string) {
    const newKey = `new-model-${Date.now()}`;
    const defaultProvider = modelMaps.availableProviderModels[0] || 'deepseek-v4-flash';
    setModelMaps((prev) => ({
      ...prev,
      [adapter]: { ...((prev as any)[adapter] as Record<string, string>), [newKey]: defaultProvider },
    }));
  }

  function handleResetMaps(adapter: string) {
    setModelMaps((prev) => ({
      ...prev,
      [adapter]: { ...(((modelMaps.defaults as any)[adapter] as Record<string, string>) || {}) },
    }));
  }

  async function handleExport() {
    const data = await apiGet('/api/settings/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'llmweb2api-config.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div className="page-header">
        <h1>Settings</h1>
      </div>

      <div className="card">
        <h3>Dashboard Password</h3>
        <div className="form-group">
          <label>New Password (leave empty to keep current)</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter new password"
          />
        </div>
      </div>

      <div className="card">
        <h3>Log Retention</h3>
        <div className="form-group">
          <label>Maximum log retention (days)</label>
          <input
            type="number"
            value={retentionDays}
            onChange={(e) => setRetentionDays(e.target.value)}
            min="1"
            max="365"
          />
        </div>
      </div>

      <div className="card">
        <h3>Conversation Cleanup</h3>
        <div className="form-group">
          <label>Auto-delete conversations after</label>
          <select
            value={conversationRetention}
            onChange={(e) => setConversationRetention(e.target.value)}
          >
            <option value="">Never</option>
            <option value="immediate">Immediately (ignored if cache is enabled)</option>
            <option value="1h">1 Hour</option>
            <option value="24h">24 Hours (1 Day)</option>
          </select>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 16 }}>Model Mapping</h3>
        <p style={{ fontSize: '12px', color: '#888', marginBottom: 12 }}>
          Map vendor models to provider models. Provider models definition: <strong>search always ON</strong>.
        </p>

        <div style={{ display: 'flex', gap: 0, marginBottom: 16, borderBottom: '2px solid #eee' }}>
          {ADAPTERS.map((a) => (
            <button
              key={a.key}
              className="btn"
              style={{
                background: activeTab === a.key ? '#00d4aa' : 'transparent',
                color: activeTab === a.key ? '#1a1a2e' : '#666',
                borderRadius: '6px 6px 0 0',
                fontWeight: activeTab === a.key ? 600 : 400,
                border: 'none',
                padding: '8px 16px',
              }}
              onClick={() => setActiveTab(a.key)}
            >
              {a.label}
            </button>
          ))}
        </div>

        <div style={{ marginBottom: 16, display: 'flex', gap: 8 }}>
          <span style={{ fontSize: '13px', color: '#666' }}>Available provider models:</span>
          {modelMaps.availableProviderModels.map((m) => (
            <code key={m} style={{ background: '#e6f9f2', padding: '2px 6px', borderRadius: 4, fontSize: '12px' }}>
              {m}
            </code>
          ))}
        </div>

        <table>
          <thead>
            <tr>
              <th style={{ width: '42%' }}>Vendor Model</th>
              <th style={{ width: '42%' }}>Provider Model</th>
              <th style={{ width: '16%' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries((modelMaps as any)[activeTab] as Record<string, string>).map(
              ([vendorModel, providerModel]) => (
                <tr key={vendorModel}>
                  <td>
                    <input
                      value={vendorModel}
                      style={{ width: '100%' }}
                      onChange={(e) => {
                        const newVendor = e.target.value;
                        setModelMaps((prev) => {
                          const copy: Record<string, string> = {};
                          for (const [k, v] of Object.entries((prev as any)[activeTab] as Record<string, string>)) {
                            copy[k === vendorModel ? newVendor : k] = v;
                          }
                          return { ...prev, [activeTab]: copy };
                        });
                      }}
                    />
                  </td>
                  <td>
                    <select
                      value={providerModel}
                      style={{ width: '100%' }}
                      onChange={(e) => handleMapChange(activeTab, vendorModel, e.target.value)}
                    >
                      {modelMaps.availableProviderModels.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <button
                      className="btn btn-danger"
                      style={{ fontSize: '11px', padding: '4px 8px' }}
                      onClick={() => handleRemoveMapping(activeTab, vendorModel)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn btn-secondary" onClick={() => handleAddMapping(activeTab)}>
            + Add Mapping
          </button>
          <button className="btn btn-secondary" onClick={() => handleResetMaps(activeTab)}>
            Reset to Default
          </button>
          <button className="btn btn-primary" onClick={() => handleSaveModelMaps(activeTab)}>
            Save Mappings
          </button>
        </div>
      </div>

      <div className="card">
        <h3>Config</h3>
        <button className="btn btn-primary" style={{ marginRight: 8 }} onClick={handleExport}>
          Export Config
        </button>
        <span style={{ color: '#888', fontSize: '12px' }}>Import coming in Phase 2</span>
      </div>

      <div style={{ marginTop: 16 }}>
        <button className="btn btn-primary" onClick={handleSaveSettings}>
          Save Settings
        </button>
        {saved && <span style={{ marginLeft: 12, color: '#00a86b' }}>Saved!</span>}
      </div>
    </div>
  );
}
