import { useEffect, useState } from 'react';
import { apiGet, apiPost, apiPut, apiDelete } from '../api/client';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { AccountModal } from '../components/AccountModal';
import { Plus, Pencil, Power, Trash2 } from 'lucide-react';

interface Account {
  id: number;
  name: string;
  provider: string;
  settings: string;
  session: string;
  enabled: number;
  created_at: string;
}

export default function Providers() {
  const [items, setItems] = useState<Account[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<Account | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    loadItems();
  }, []);

  async function loadItems() {
    const data = await apiGet<Account[]>('/api/accounts');
    setItems(data);
  }

  async function handleSave(data: any) {
    if (editingItem) {
      await apiPut(`/api/accounts/${editingItem.id}`, data);
    } else {
      await apiPost('/api/accounts', data);
    }
    setModalOpen(false);
    setEditingItem(null);
    await loadItems();
    setToast('Account saved successfully');
    setTimeout(() => setToast(null), 2000);
  }

  async function handleToggle(item: Account) {
    await apiPut(`/api/accounts/${item.id}`, { enabled: item.enabled ? 0 : 1 });
    await loadItems();
  }

  async function handleDelete(id: number) {
    if (confirm('Are you sure you want to delete this account?')) {
      await apiDelete(`/api/accounts/${id}`);
      await loadItems();
    }
  }

  function openEdit(item: Account) {
    setEditingItem(item);
    setModalOpen(true);
  }

  function openNew() {
    setEditingItem(null);
    setModalOpen(true);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Accounts</h1>
          <p className="text-muted-foreground">Manage your provider accounts</p>
        </div>
        <Button onClick={openNew}>
          <Plus className="mr-2 h-4 w-4" />
          Add Account
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Provider Accounts</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Settings</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>{item.id}</TableCell>
                  <TableCell className="font-medium">{item.name}</TableCell>
                  <TableCell>
                    <code className="rounded bg-muted px-2 py-1 text-xs">{item.provider}</code>
                  </TableCell>
                  <TableCell className="max-w-[200px] truncate font-mono text-xs">{item.settings}</TableCell>
                  <TableCell>
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium ${
                        item.enabled ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                      }`}
                    >
                      {item.enabled ? 'Active' : 'Disabled'}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm">{new Date(item.created_at).toLocaleDateString()}</TableCell>
                  <TableCell className="text-right space-x-2">
                    <Button variant="ghost" size="sm" onClick={() => openEdit(item)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => handleToggle(item)}>
                      <Power className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => handleDelete(item.id)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground">
                    No accounts yet
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <AccountModal open={modalOpen} onOpenChange={setModalOpen} editingAccount={editingItem} onSave={handleSave} />

      {toast && (
        <div className="fixed bottom-4 right-4 rounded-lg bg-green-100 p-4 text-green-700 shadow-lg">
          <p className="text-sm">{toast}</p>
        </div>
      )}
    </div>
  );
}
