import { useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Textarea } from './ui/textarea';

interface Account {
  id: number;
  name: string;
  provider: string;
  settings: string;
  session: string;
  enabled: number;
  created_at: string;
}

const PROVIDER_TYPES = ['deepseek', 'chatgpt', 'qwen'];

interface AccountModalFormProps {
  editingAccount: Account | null;
  onSave: (data: any) => Promise<void>;
  onCancel: () => void;
}

export function AccountModalForm({ editingAccount, onSave, onCancel }: AccountModalFormProps) {
  const [name, setName] = useState(editingAccount ? editingAccount.name : '');
  const [provider, setProvider] = useState(editingAccount ? editingAccount.provider : 'deepseek');
  const [settings, setSettings] = useState(() => {
    if (!editingAccount) return '{}';
    if (editingAccount.provider === 'deepseek' || editingAccount.provider === 'qwen') return '{}';
    return editingAccount.settings;
  });
  const [email, setEmail] = useState(() => {
    if (!editingAccount || editingAccount.provider !== 'deepseek') return '';
    try {
      return JSON.parse(editingAccount.settings).email || '';
    } catch {
      return '';
    }
  });
  const [password, setPassword] = useState(() => {
    if (!editingAccount || editingAccount.provider !== 'deepseek') return '';
    try {
      return JSON.parse(editingAccount.settings).password || '';
    } catch {
      return '';
    }
  });
  const [token, setToken] = useState(() => {
    if (!editingAccount || editingAccount.provider !== 'qwen') return '';
    try {
      return JSON.parse(editingAccount.settings).token || '';
    } catch {
      return '';
    }
  });
  const [error, setError] = useState('');

  const handleProviderChange = (value: string) => {
    setProvider(value);
    setEmail('');
    setPassword('');
    setToken('');
    setSettings('{}');
    setError('');
  };

  const handleSave = async () => {
    if (!name.trim()) return;

    let settingsData: Record<string, unknown>;
    if (provider === 'deepseek') {
      if (!email.trim()) {
        setError('Email is required');
        return;
      }
      if (!password.trim()) {
        setError('Password is required');
        return;
      }
      settingsData = { type: 'email+password', email: email.trim(), password };
    } else if (provider === 'qwen') {
      if (!token.trim()) {
        setError('Token is required');
        return;
      }
      settingsData = { token: token.trim() };
    } else {
      try {
        settingsData = JSON.parse(settings);
      } catch {
        setError('Invalid JSON');
        return;
      }
    }

    await onSave({ name: name.trim(), provider, settings: settingsData });
  };

  return (
    <>
      <div className="grid gap-4 py-4">
        <div className="grid gap-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Demo Account" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="provider">Provider Type</Label>
          <Select value={provider} onValueChange={handleProviderChange}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROVIDER_TYPES.map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {provider === 'deepseek' ? (
          <>
            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
          </>
        ) : provider === 'qwen' ? (
          <div className="grid gap-2">
            <Label htmlFor="token">Token (JWT from cookie)</Label>
            <Input id="token" value={token} onChange={(e) => setToken(e.target.value)} placeholder="eyJhbGciOi..." />
          </div>
        ) : (
          <div className="grid gap-2">
            <Label htmlFor="settings">Settings (JSON)</Label>
            <Textarea
              id="settings"
              value={settings}
              onChange={(e) => {
                setSettings(e.target.value);
                setError('');
              }}
              rows={6}
              className="font-mono text-sm"
            />
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
      <div className="flex justify-end gap-2 mt-2">
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={handleSave}>{editingAccount ? 'Update' : 'Save'}</Button>
      </div>
    </>
  );
}
