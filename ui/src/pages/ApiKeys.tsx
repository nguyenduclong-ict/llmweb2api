import { useEffect, useState } from 'react';
import { apiGet, apiPost, apiPut, apiDelete } from '../api/client';

interface ApiKey {
  id: number;
  key: string;
  name: string;
  cache: number;
  enabled: number;
  created_at: string;
}

export default function ApiKeys() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [formName, setFormName] = useState('');
  const [formKey, setFormKey] = useState('');
  const [formCache, setFormCache] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    loadKeys();
  }, []);

  async function loadKeys() {
    const data = await apiGet<ApiKey[]>('/api/api-keys');
    setKeys(data);
  }

  function resetForm() {
    setFormName('');
    setFormKey('');
    setFormCache(false);
    setEditingId(null);
    setShowAdd(false);
  }

  function startEdit(item: ApiKey) {
    setEditingId(item.id);
    setFormName(item.name);
    setFormCache(!!item.cache);
    setShowAdd(true);
  }

  function handleGenerateKey() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let key = 'sk-';
    for (let i = 0; i < 48; i++) key += chars[Math.floor(Math.random() * chars.length)];
    setFormKey(key);
  }

  async function handleSave() {
    if (!formName.trim()) return;

    if (editingId !== null) {
      await apiPut(`/api/api-keys/${editingId}`, { name: formName, cache: formCache });
    } else {
      const created = await apiPost<ApiKey>('/api/api-keys', {
        name: formName.trim(),
        key: formKey || undefined,
        cache: formCache,
      });
      if (!editingId) {
        setCopiedKey(created.key);
        navigator.clipboard.writeText(created.key);
      }
    }
    resetForm();
    loadKeys();
  }

  async function handleToggle(item: ApiKey) {
    await apiPut(`/api/api-keys/${item.id}`, { enabled: item.enabled ? 0 : 1 });
    loadKeys();
  }

  async function handleDelete(id: number) {
    await apiDelete(`/api/api-keys/${id}`);
    loadKeys();
  }

  return (
    <div>
      <div className="page-header">
        <h1>API Keys</h1>
        <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
          + Create API Key
        </button>
      </div>

      {copiedKey && (
        <div className="card" style={{ background: '#e6f9f2', borderLeft: '4px solid #00d4aa' }}>
          <strong>API Key Created & Copied!</strong>
          <p style={{ marginTop: 8, fontFamily: 'monospace', wordBreak: 'break-all', fontSize: '12px' }}>{copiedKey}</p>
          <button className="btn btn-secondary" style={{ marginTop: 8 }} onClick={() => setCopiedKey(null)}>
            Dismiss
          </button>
        </div>
      )}

      {showAdd && (
        <div className="card">
          <h3>{editingId !== null ? 'Edit API Key' : 'Create New API Key'}</h3>
          <div className="form-group">
            <label>Name</label>
            <input value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="e.g. My App" />
          </div>
          {editingId === null && (
            <div className="form-group">
              <label>Key</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  value={formKey}
                  onChange={(e) => setFormKey(e.target.value)}
                  placeholder="Leave empty to auto-generate"
                  style={{ flex: 1, fontFamily: 'monospace', fontSize: '12px' }}
                />
                <button className="btn btn-secondary" onClick={handleGenerateKey} style={{ whiteSpace: 'nowrap' }}>
                  Generate
                </button>
              </div>
            </div>
          )}
          <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              id="cache-check"
              checked={formCache}
              onChange={(e) => setFormCache(e.target.checked)}
              style={{ width: 16, height: 16 }}
            />
            <label htmlFor="cache-check" style={{ margin: 0, cursor: 'pointer' }}>
              Enable cache
            </label>
          </div>
          <button className="btn btn-primary" onClick={handleSave}>
            {editingId !== null ? 'Update' : 'Create'}
          </button>
          <button className="btn btn-secondary" style={{ marginLeft: 8 }} onClick={resetForm}>
            Cancel
          </button>
        </div>
      )}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th style={{ width: 50 }}>ID</th>
              <th>Name</th>
              <th>Key</th>
              <th style={{ width: 70 }}>Cache</th>
              <th style={{ width: 80 }}>Status</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td>{k.id}</td>
                <td>
                  <strong>{k.name}</strong>
                </td>
                <td style={{ fontFamily: 'monospace', fontSize: '11px' }}>
                  {k.key.slice(0, 12)}...{k.key.slice(-8)}
                </td>
                <td style={{ textAlign: 'center' }}>{k.cache ? 'Yes' : 'No'}</td>
                <td>
                  <span className={`status-badge ${k.enabled ? 'enabled' : 'disabled'}`}>
                    {k.enabled ? 'Active' : 'Disabled'}
                  </span>
                </td>
                <td>{new Date(k.created_at).toLocaleDateString()}</td>
                <td>
                  <button className="btn btn-secondary" style={{ marginRight: 6 }} onClick={() => startEdit(k)}>
                    Edit
                  </button>
                  <button className="btn btn-secondary" style={{ marginRight: 6 }} onClick={() => handleToggle(k)}>
                    {k.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button className="btn btn-danger" onClick={() => handleDelete(k.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {keys.length === 0 && (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', color: '#999' }}>
                  No API keys yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
