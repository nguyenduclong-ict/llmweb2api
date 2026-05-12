import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { apiDelete, apiGet } from '../api/client';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';

interface SessionSummary {
  conversation_id: string;
  seq: number;
  account_id: number | null;
  account_name: string | null;
  provider: string;
  metadata: string;
  tracked_count: number;
  tracked_hash: string;
  tools_hash: string | null;
  last_message_id: string | null;
  prompt_cache_key: string | null;
  last_used: string;
  created_at: string;
  updated_at: string;
  seq_count: number;
}

function parseMetadata(metadata: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(metadata || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function formatDate(value: string): string {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function Sessions() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  async function loadSessions() {
    setLoading(true);
    try {
      const data = await apiGet<SessionSummary[]>('/api/sessions');
      setSessions(data);
      setSelectedIds((prev) => prev.filter((id) => data.some((session) => session.conversation_id === id)));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;

    apiGet<SessionSummary[]>('/api/sessions')
      .then((data) => {
        if (active) {
          setSessions(data);
          setSelectedIds((prev) => prev.filter((id) => data.some((session) => session.conversation_id === id)));
        }
      })
      .catch(console.error);

    return () => {
      active = false;
    };
  }, []);

  async function deleteSession(conversationId: string) {
    if (!confirm(`Delete session ${conversationId}?`)) return;
    setDeletingId(conversationId);
    try {
      await apiDelete(`/api/sessions/${encodeURIComponent(conversationId)}`);
      await loadSessions();
      setSelectedIds((prev) => prev.filter((id) => id !== conversationId));
      toast.success('Session deleted');
    } finally {
      setDeletingId(null);
    }
  }

  function toggleSession(conversationId: string) {
    setSelectedIds((prev) =>
      prev.includes(conversationId) ? prev.filter((id) => id !== conversationId) : [...prev, conversationId],
    );
  }

  function toggleAllSessions() {
    setSelectedIds((prev) =>
      prev.length === sessions.length ? [] : sessions.map((session) => session.conversation_id),
    );
  }

  async function deleteSelectedSessions() {
    if (selectedIds.length === 0) return;
    if (!confirm(`Delete ${selectedIds.length} selected sessions?`)) return;
    setBulkDeleting(true);
    try {
      for (const conversationId of selectedIds) {
        await apiDelete(`/api/sessions/${encodeURIComponent(conversationId)}`);
      }
      await loadSessions();
      setSelectedIds([]);
      toast.success('Selected sessions deleted');
    } finally {
      setBulkDeleting(false);
    }
  }

  const totalSeq = useMemo(() => sessions.reduce((sum, session) => sum + session.seq_count, 0), [sessions]);
  const selectedCount = selectedIds.length;
  const allSelected = sessions.length > 0 && selectedCount === sessions.length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Sessions</h1>
          <p className="text-muted-foreground">
            {sessions.length} active conversation IDs, {totalSeq} stored sequences
          </p>
        </div>
        <div className="flex gap-2">
          {selectedCount > 0 && (
            <Button variant="destructive" onClick={deleteSelectedSessions} disabled={bulkDeleting}>
              <Trash2 className="mr-2 h-4 w-4" />
              Delete Selected ({selectedCount})
            </Button>
          )}
          <Button variant="outline" onClick={loadSessions} disabled={loading}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Conversation Sessions</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border"
                    checked={allSelected}
                    disabled={sessions.length === 0}
                    onChange={toggleAllSessions}
                    aria-label="Select all sessions"
                  />
                </TableHead>
                <TableHead>Conversation ID</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Seq</TableHead>
                <TableHead>Messages</TableHead>
                <TableHead>Provider Session</TableHead>
                <TableHead>Last Used</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((session) => {
                const metadata = parseMetadata(session.metadata);
                const providerSessionId = metadata.providerSessionId as string | undefined;
                return (
                  <TableRow key={session.conversation_id}>
                    <TableCell>
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border"
                        checked={selectedIds.includes(session.conversation_id)}
                        onChange={() => toggleSession(session.conversation_id)}
                        aria-label={`Select session ${session.conversation_id}`}
                      />
                    </TableCell>
                    <TableCell>
                      <code className="break-all rounded bg-muted px-2 py-1 text-xs">{session.conversation_id}</code>
                    </TableCell>
                    <TableCell>{session.provider || '-'}</TableCell>
                    <TableCell>
                      {session.account_name || session.account_id ? (
                        <div className="space-y-1">
                          <div>{session.account_name || '-'}</div>
                          <div className="text-xs text-muted-foreground">ID: {session.account_id}</div>
                        </div>
                      ) : (
                        '-'
                      )}
                    </TableCell>
                    <TableCell>
                      {session.seq}
                      <span className="text-muted-foreground"> / {session.seq_count}</span>
                    </TableCell>
                    <TableCell>{session.tracked_count}</TableCell>
                    <TableCell>
                      <code className="break-all rounded bg-muted px-2 py-1 text-xs">{providerSessionId || '-'}</code>
                    </TableCell>
                    <TableCell className="text-sm">{formatDate(session.last_used || session.updated_at)}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => deleteSession(session.conversation_id)}
                        disabled={deletingId === session.conversation_id}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
              {sessions.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground">
                    No sessions found
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
