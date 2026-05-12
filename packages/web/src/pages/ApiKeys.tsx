import { useEffect, useState } from 'react';
import { apiGet, apiPost, apiPut, apiDelete } from '../api/client';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { ApiKeyModal } from '../components/ApiKeyModal';
import { Plus, Pencil, Power, Trash2, Copy, Check } from 'lucide-react';
import { toast } from 'sonner';

interface ApiKey {
  id: number;
  key: string;
  name: string;
  enabled: number;
  created_at: string;
}

export default function ApiKeys() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<ApiKey | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  useEffect(() => {
    loadKeys();
  }, []);

  async function loadKeys() {
    const data = await apiGet<ApiKey[]>('/api/api-keys');
    setKeys(data);
  }

  async function handleSave(data: any) {
    if (editingKey) {
      await apiPut(`/api/api-keys/${editingKey.id}`, data);
    } else {
      await apiPost<ApiKey>('/api/api-keys', data);
    }
    setModalOpen(false);
    setEditingKey(null);
    await loadKeys();
    toast.success('API key saved');
  }

  async function handleToggle(item: ApiKey) {
    await apiPut(`/api/api-keys/${item.id}`, { enabled: item.enabled ? 0 : 1 });
    await loadKeys();
    toast.success(item.enabled ? 'API key disabled' : 'API key enabled');
  }

  async function handleDelete(id: number) {
    if (confirm('Are you sure you want to delete this API key?')) {
      await apiDelete(`/api/api-keys/${id}`);
      await loadKeys();
      toast.success('API key deleted');
    }
  }

  function openEdit(item: ApiKey) {
    setEditingKey(item);
    setModalOpen(true);
  }

  function openNew() {
    setEditingKey(null);
    setModalOpen(true);
  }

  function handleKeyGenerated(key: string) {
    navigator.clipboard.writeText(key);
    toast.success('API key copied to clipboard');
  }

  function copyKey(key: string, id: number) {
    navigator.clipboard.writeText(key);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
    toast.success('Copied to clipboard');
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">API Keys</h1>
          <p className="text-muted-foreground">Manage API keys for authentication</p>
        </div>
        <Button onClick={openNew}>
          <Plus className="mr-2 h-4 w-4" />
          Create API Key
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>API Keys</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((k) => (
                <TableRow key={k.id}>
                  <TableCell>{k.id}</TableCell>
                  <TableCell className="font-medium">{k.name}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <code className="rounded bg-muted px-2 py-1 text-xs">
                        {k.key.slice(0, 12)}...{k.key.slice(-8)}
                      </code>
                      <Button variant="ghost" size="sm" onClick={() => copyKey(k.key, k.id)}>
                        {copiedId === k.id ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                      </Button>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium ${
                        k.enabled ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                      }`}
                    >
                      {k.enabled ? 'Active' : 'Disabled'}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm">{new Date(k.created_at).toLocaleDateString()}</TableCell>
                  <TableCell className="text-right space-x-2">
                    <Button variant="ghost" size="sm" onClick={() => openEdit(k)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => handleToggle(k)}>
                      <Power className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => handleDelete(k.id)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {keys.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    No API keys yet
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <ApiKeyModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        editingKey={editingKey}
        onSave={handleSave}
        onKeyGenerated={handleKeyGenerated}
      />
    </div>
  );
}
