import { useEffect, useState } from 'react';
import { apiGet, apiPut } from '../api/client';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Save, Download, Plus, Trash2, RotateCcw } from 'lucide-react';

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

const ADAPTERS = [{ key: 'openai', label: 'OpenAI' }] as const;

export default function Settings() {
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
  const [activeTab, setActiveTab] = useState<'openai'>('openai');

  useEffect(() => {
    apiGet<AppSettings>('/api/settings')
      .then((data) => {
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
    // eslint-disable-next-line react-hooks/purity
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
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">Configure application settings</p>
      </div>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Dashboard Security</CardTitle>
            <CardDescription>Update your dashboard access password</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="password">New Password (leave empty to keep current)</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter new password"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Log Management</CardTitle>
            <CardDescription>Configure log retention and cleanup</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="retention">Maximum log retention (days)</Label>
                <Input
                  id="retention"
                  type="number"
                  value={retentionDays}
                  onChange={(e) => setRetentionDays(e.target.value)}
                  min="1"
                  max="365"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Conversation Cleanup</CardTitle>
            <CardDescription>Auto-delete conversations after specified time</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2">
              <Label htmlFor="conversation">Auto-delete conversations after</Label>
              <Select value={conversationRetention} onValueChange={setConversationRetention}>
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder="Never" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="never">Never</SelectItem>
                  <SelectItem value="immediate">Immediately (ignored if cache is enabled)</SelectItem>
                  <SelectItem value="1h">1 Hour</SelectItem>
                  <SelectItem value="24h">24 Hours (1 Day)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Model Mapping</CardTitle>
            <CardDescription>
              Map vendor models to provider models. Provider models definition: <strong>search always ON</strong>.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <span className="text-sm text-muted-foreground">Available provider models:</span>
              {modelMaps.availableProviderModels.map((m) => (
                <code key={m} className="rounded bg-muted px-2 py-1 text-xs">
                  {m}
                </code>
              ))}
            </div>

            <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)}>
              <TabsList>
                {ADAPTERS.map((a) => (
                  <TabsTrigger key={a.key} value={a.key}>
                    {a.label}
                  </TabsTrigger>
                ))}
              </TabsList>
              {ADAPTERS.map((a) => (
                <TabsContent key={a.key} value={a.key} className="space-y-4">
                  <div className="rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-[42%]">Vendor Model</TableHead>
                          <TableHead className="w-[42%]">Provider Model</TableHead>
                          <TableHead className="w-[16%]">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {Object.entries((modelMaps as any)[a.key] as Record<string, string>).map(
                          ([vendorModel, providerModel]) => (
                            <TableRow key={vendorModel}>
                              <TableCell>
                                <Input
                                  value={vendorModel}
                                  onChange={(e) => {
                                    const newVendor = e.target.value;
                                    setModelMaps((prev) => {
                                      const copy: Record<string, string> = {};
                                      for (const [k, v] of Object.entries(
                                        (prev as any)[a.key] as Record<string, string>,
                                      )) {
                                        copy[k === vendorModel ? newVendor : k] = v;
                                      }
                                      return { ...prev, [a.key]: copy };
                                    });
                                  }}
                                />
                              </TableCell>
                              <TableCell>
                                <Select
                                  value={providerModel}
                                  onValueChange={(v) => handleMapChange(a.key, vendorModel, v)}
                                >
                                  <SelectTrigger>
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {modelMaps.availableProviderModels.map((m) => (
                                      <SelectItem key={m} value={m}>
                                        {m}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </TableCell>
                              <TableCell>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleRemoveMapping(a.key, vendorModel)}
                                >
                                  <Trash2 className="h-4 w-4 text-destructive" />
                                </Button>
                              </TableCell>
                            </TableRow>
                          ),
                        )}
                        {Object.keys((modelMaps as any)[a.key] || {}).length === 0 && (
                          <TableRow>
                            <TableCell colSpan={3} className="text-center text-muted-foreground">
                              No mappings yet
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => handleAddMapping(a.key)}>
                      <Plus className="mr-2 h-4 w-4" />
                      Add Mapping
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => handleResetMaps(a.key)}>
                      <RotateCcw className="mr-2 h-4 w-4" />
                      Reset to Default
                    </Button>
                    <Button size="sm" onClick={() => handleSaveModelMaps(a.key)}>
                      <Save className="mr-2 h-4 w-4" />
                      Save Mappings
                    </Button>
                  </div>
                </TabsContent>
              ))}
            </Tabs>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Configuration</CardTitle>
            <CardDescription>Export or import configuration</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2">
              <Button variant="outline" onClick={handleExport}>
                <Download className="mr-2 h-4 w-4" />
                Export Config
              </Button>
              <span className="text-sm text-muted-foreground">Import coming in Phase 2</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex items-center gap-4">
        <Button onClick={handleSaveSettings}>
          <Save className="mr-2 h-4 w-4" />
          Save Settings
        </Button>
        {saved && <span className="text-sm text-green-600">Saved!</span>}
      </div>
    </div>
  );
}
