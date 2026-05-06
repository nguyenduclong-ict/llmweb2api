import { useEffect, useState } from 'react';
import { apiGet, apiPost, apiPut, apiDelete } from '../api/client';

interface Account {
  id: number;
  name: string;
  provider: string;
  settings: string;
  session: string;
  enabled: number;
  created_at: string;
}

const PROVIDER_TYPES = ['deepseek', 'chatgpt'];

export default function Providers() {
  const [items, setItems] = useState<Account[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  const [formName, setFormName] = useState('');
  const [formProvider, setFormProvider] = useState('deepseek');
  const [formSettings, setFormSettings] = useState('{}');
  const [formEmail, setFormEmail] = useState('');
  const [formPassword, setFormPassword] = useState('');
  const [settingsError, setSettingsError] = useState('');

  useEffect(() => {
    loadItems();
  }, []);

  async function loadItems() {
    const data = await apiGet<Account[]>('/api/accounts');
    setItems(data);
  }

  function resetForm() {
    setFormName('');
    setFormProvider('deepseek');
    setFormSettings('{}');
    setFormEmail('');
    setFormPassword('');
    setSettingsError('');
    setEditingId(null);
    setShowAdd(false);
  }

  function startEdit(item: Account) {
    setEditingId(item.id);
    setFormName(item.name);
    setFormProvider(item.provider);
    try {
      const parsed = JSON.parse(item.settings);
      if (item.provider === 'deepseek') {
        setFormEmail(parsed.email || '');
        setFormPassword(parsed.password || '');
        setFormSettings('{}');
      } else {
        setFormSettings(item.settings);
        setFormEmail('');
        setFormPassword('');
      }
    } catch {
      setFormSettings(item.settings);
    }
    setSettingsError('');
    setShowAdd(true);
  }

  function handleProviderChange(provider: string) {
    setFormProvider(provider);
    setFormEmail('');
    setFormPassword('');
    setFormSettings('{}');
    setSettingsError('');
  }

  async function handleSave() {
    if (!formName.trim()) return;

    let settings: Record<string, unknown>;
    if (formProvider === 'deepseek') {
      if (!formEmail.trim()) {
        setSettingsError('Email is required');
        return;
      }
      if (!formPassword.trim()) {
        setSettingsError('Password is required');
        return;
      }
      settings = { type: 'email+password', email: formEmail.trim(), password: formPassword };
    } else {
      try {
        settings = JSON.parse(formSettings);
      } catch {
        setSettingsError('Invalid JSON');
        return;
      }
    }

    if (editingId !== null) {
      await apiPut(`/api/accounts/${editingId}`, { name: formName, provider: formProvider, settings });
    } else {
      await apiPost('/api/accounts', { name: formName.trim(), provider: formProvider, settings });
    }
    resetForm();
    loadItems();
  }

  async function handleToggle(item: Account) {
    await apiPut(`/api/accounts/${item.id}`, { enabled: item.enabled ? 0 : 1 });
    loadItems();
  }

  async function handleDelete(id: number) {
    await apiDelete(`/api/accounts/${id}`);
    loadItems();
  }

  return (
    <div>
      <div className="page-header">
        <h1>Accounts</h1>
        <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
          + Add Account
        </button>
      </div>

      {showAdd && (
        <div className="card">
          <h3>{editingId !== null ? 'Edit Account' : 'Add New Account'}</h3>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div className="form-group" style={{ flex: 1, minWidth: 180 }}>
              <label>Name</label>
              <input value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="e.g. Demo Account" />
            </div>
            <div className="form-group" style={{ flex: 1, minWidth: 180 }}>
              <label>Provider Type</label>
              <select value={formProvider} onChange={(e) => handleProviderChange(e.target.value)}>
                {PROVIDER_TYPES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {formProvider === 'deepseek' ? (
            <div>
              <div className="form-group">
                <label>Email</label>
                <input
                  value={formEmail}
                  onChange={(e) => setFormEmail(e.target.value)}
                  placeholder="user@example.com"
                  type="email"
                />
              </div>
              <div className="form-group">
                <label>Password</label>
                <input
                  value={formPassword}
                  onChange={(e) => setFormPassword(e.target.value)}
                  placeholder="Password"
                  type="password"
                />
              </div>
            </div>
          ) : (
            <div className="form-group">
              <label>Settings (JSON)</label>
              <textarea
                value={formSettings}
                onChange={(e) => {
                  setFormSettings(e.target.value);
                  setSettingsError('');
                }}
                rows={6}
                style={{
                  width: '100%',
                  fontFamily: 'monospace',
                  fontSize: '12px',
                  padding: '8px 12px',
                  border: `1px solid ${settingsError ? '#e74c3c' : '#ddd'}`,
                  borderRadius: 6,
                }}
              />
              {settingsError && <span style={{ color: '#e74c3c', fontSize: '12px' }}>{settingsError}</span>}
            </div>
          )}
          <button className="btn btn-primary" onClick={handleSave}>
            {editingId !== null ? 'Update' : 'Save'}
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
              <th>Provider</th>
              <th>Settings</th>
              <th>Status</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{item.id}</td>
                <td>
                  <strong>{item.name}</strong>
                </td>
                <td>
                  <code style={{ background: '#e6f9f2', padding: '2px 6px', borderRadius: 4, fontSize: '12px' }}>
                    {item.provider}
                  </code>
                </td>
                <td
                  style={{
                    fontFamily: 'monospace',
                    fontSize: '11px',
                    maxWidth: 250,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {item.settings}
                </td>
                <td>
                  <span className={`status-badge ${item.enabled ? 'enabled' : 'disabled'}`}>
                    {item.enabled ? 'Active' : 'Disabled'}
                  </span>
                </td>
                <td>{new Date(item.created_at).toLocaleDateString()}</td>
                <td>
                  <button className="btn btn-secondary" style={{ marginRight: 6 }} onClick={() => startEdit(item)}>
                    Edit
                  </button>
                  <button className="btn btn-secondary" style={{ marginRight: 6 }} onClick={() => handleToggle(item)}>
                    {item.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button className="btn btn-danger" onClick={() => handleDelete(item.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', color: '#999' }}>
                  No accounts yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
