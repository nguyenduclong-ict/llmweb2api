import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Switch } from './ui/switch';

interface ApiKey {
  id: number;
  key: string;
  name: string;
  cache: number;
  enabled: number;
  created_at: string;
}

interface ApiKeyModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingKey: ApiKey | null;
  onSave: (data: any) => Promise<ApiKey | void>;
  onKeyGenerated?: (key: string) => void;
}

function ApiKeyForm({ editingKey, onSave, onCancel, onKeyGenerated }: {
  editingKey: ApiKey | null;
  onSave: (data: any) => Promise<ApiKey | void>;
  onCancel: () => void;
  onKeyGenerated?: (key: string) => void;
}) {
  const [name, setName] = useState(editingKey ? editingKey.name : '');
  const [key, setKey] = useState('');
  const [cache, setCache] = useState(editingKey ? !!editingKey.cache : true);

  const generateKey = () => {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let newKey = 'sk-';
    for (let i = 0; i < 48; i++) newKey += chars[Math.floor(Math.random() * chars.length)];
    setKey(newKey);
  };

  const handleSave = async () => {
    if (!name.trim()) return;
    const result = await onSave(
      editingKey ? { name: name.trim(), cache } : { name: name.trim(), key: key || undefined, cache },
    );
    if (!editingKey && result && 'key' in result && onKeyGenerated) {
      onKeyGenerated(result.key);
    }
  };

  return (
    <>
      <div className="grid gap-4 py-4">
        <div className="grid gap-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. My App" />
        </div>
        {!editingKey && (
          <div className="grid gap-2">
            <Label htmlFor="key">Key</Label>
            <div className="flex gap-2">
              <Input
                id="key"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="Leave empty to auto-generate"
                className="font-mono text-sm"
              />
              <Button type="button" variant="outline" onClick={generateKey}>
                Generate
              </Button>
            </div>
          </div>
        )}
        <div className="flex items-center justify-between">
          <Label htmlFor="cache">Enable cache</Label>
          <Switch id="cache" checked={cache} onCheckedChange={setCache} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={handleSave}>{editingKey ? 'Update' : 'Create'}</Button>
      </DialogFooter>
    </>
  );
}

export function ApiKeyModal({ open, onOpenChange, editingKey, onSave, onKeyGenerated }: ApiKeyModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <div key={editingKey ? editingKey.id : 'new'}>
          <DialogHeader>
            <DialogTitle>{editingKey ? 'Edit API Key' : 'Create New API Key'}</DialogTitle>
            <DialogDescription>
              {editingKey ? 'Update API key details below.' : 'Create a new API key for authentication.'}
            </DialogDescription>
          </DialogHeader>
          <ApiKeyForm
            editingKey={editingKey}
            onSave={onSave}
            onCancel={() => onOpenChange(false)}
            onKeyGenerated={onKeyGenerated}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
