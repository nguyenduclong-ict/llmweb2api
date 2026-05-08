import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog';
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

interface AccountModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingAccount: Account | null;
  onSave: (data: any) => Promise<void>;
}

const PROVIDER_TYPES = ['deepseek', 'chatgpt'];

export function AccountModal({ open, onOpenChange, editingAccount, onSave }: AccountModalProps) {
  const [name, setName] = useState('');
  const [provider, setProvider] = useState('deepseek');
  const [settings, setSettings] = useState('{}');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const resetForm = () => {
    setName('');
    setProvider('deepseek');
    setSettings('{}');
    setEmail('');
    setPassword('');
    setError('');
  };

  useEffect(() => {
    if (editingAccount) {
      setName(editingAccount.name);
      setProvider(editingAccount.provider);
      try {
        const parsed = JSON.parse(editingAccount.settings);
        if (editingAccount.provider === 'deepseek') {
          setEmail(parsed.email || '');
          setPassword(parsed.password || '');
          setSettings('{}');
        } else {
          setSettings(editingAccount.settings);
          setEmail('');
          setPassword('');
        }
      } catch {
        setSettings(editingAccount.settings);
      }
    } else if (open) {
      resetForm();
    }
  }, [editingAccount, open]);

  const handleProviderChange = (value: string) => {
    setProvider(value);
    setEmail('');
    setPassword('');
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
    } else {
      try {
        settingsData = JSON.parse(settings);
      } catch {
        setError('Invalid JSON');
        return;
      }
    }

    await onSave({ name: name.trim(), provider, settings: settingsData });
    onOpenChange(false);
    resetForm();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{editingAccount ? 'Edit Account' : 'Add New Account'}</DialogTitle>
          <DialogDescription>
            {editingAccount ? 'Update account details below.' : 'Fill in the account information.'}
          </DialogDescription>
        </DialogHeader>
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
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave}>{editingAccount ? 'Update' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
