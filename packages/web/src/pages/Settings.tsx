import { useEffect, useState } from 'react';
import { apiGet, apiPut } from '../api/client';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Textarea } from '../components/ui/textarea';
import { Save, Download, Plus, Trash2, RotateCcw, Copy, Check, Terminal } from 'lucide-react';

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

interface ApiKey {
  id: number;
  key: string;
  name: string;
  cache: number;
  enabled: number;
  created_at: string;
}

type CliTool = 'codex' | 'opencode';

const ADAPTERS = [{ key: 'openai', label: 'OpenAI' }] as const;

const CLI_TOOLS: Array<{ key: CliTool; label: string }> = [
  { key: 'codex', label: 'Codex' },
  { key: 'opencode', label: 'OpenCode' },
];

const DEFAULT_PROVIDER_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-reasoner'];

function getCliApiBaseUrl(): string {
  return `${window.location.origin}/v1`;
}

function getCliEndpointUrl(tool: CliTool): string {
  const baseUrl = getCliApiBaseUrl();
  return tool === 'codex' ? `${baseUrl}/responses` : baseUrl;
}

export default function Settings() {
  const [password, setPassword] = useState('');
  const [retentionDays, setRetentionDays] = useState('30');
  const [conversationRetention, setConversationRetention] = useState('');
  const [saved, setSaved] = useState(false);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [selectedCli, setSelectedCli] = useState<CliTool>('codex');
  const [selectedApiKeyId, setSelectedApiKeyId] = useState('');
  const [copiedCliSnippet, setCopiedCliSnippet] = useState(false);
  const [copiedRevertCommand, setCopiedRevertCommand] = useState(false);

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

    apiGet<ApiKey[]>('/api/api-keys')
      .then((data) => {
        setApiKeys(data);
        const firstEnabled = data.find((key) => key.enabled) || data[0];
        if (firstEnabled) setSelectedApiKeyId(String(firstEnabled.id));
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

  function buildCliSnippet(): string {
    return buildNodeCommand(buildCliSetupScript());
  }

  function buildCliSetupScript(): string {
    const selectedKey = apiKeys.find((key) => String(key.id) === selectedApiKeyId);
    const apiKey = selectedKey?.key || '<select-api-key>';
    const baseUrl = getCliApiBaseUrl();
    const providerModels = modelMaps.availableProviderModels.length
      ? modelMaps.availableProviderModels
      : DEFAULT_PROVIDER_MODELS;
    const revertCommand = buildRevertCommand();
    return `const fs = require('fs');
const os = require('os');
const path = require('path');
const tool = ${JSON.stringify(selectedCli)};
const apiKey = ${JSON.stringify(apiKey)};
const baseUrl = ${JSON.stringify(baseUrl)};
const providerModels = ${JSON.stringify(providerModels, null, 2)};
const revertCommand = ${JSON.stringify(revertCommand)};
const defaultModel = providerModels[0] || 'deepseek-v4-flash';
const endpointUrl = tool === 'codex' ? baseUrl + '/responses' : baseUrl;

function getOpenCodeConfigRoot() {
  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  }
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

function getTargetFiles() {
  if (tool === 'codex') {
    const root = path.join(os.homedir(), '.codex');
    return [
      { file: path.join(root, 'config.toml'), content: buildCodexConfig() },
      { file: path.join(root, 'auth.json'), content: buildCodexAuth() },
    ];
  }
  return [{ file: path.join(getOpenCodeConfigRoot(), 'opencode', 'opencode.json'), content: buildOpenCodeConfig() }];
}

function buildCodexConfig() {
  return [
    'model = ' + JSON.stringify(defaultModel),
    'model_provider = "llmweb2api"',
    'cli_auth_credentials_store = "file"',
    '',
    '[model_providers.llmweb2api]',
    'name = "llmweb2api"',
    'base_url = ' + JSON.stringify(baseUrl),
    'wire_api = "responses"',
    'requires_openai_auth = true',
    '',
  ].join('\\n');
}

function buildCodexAuth() {
  return JSON.stringify({ OPENAI_API_KEY: apiKey, auth_mode: 'apikey' }, null, 2) + '\\n';
}

function buildOpenCodeConfig() {
  const models = Object.fromEntries(
    providerModels.map((model) => [
      model,
      {
        name: model,
        modalities: {
          input: ['text', 'image'],
          output: ['text'],
        },
        limit: {
          output: 32000,
          context: 480000,
        },
        options: {
          thinking: {
            type: 'enabled',
          },
        },
        compaction: {
          threshold: 0.8,
        },
      },
    ]),
  );
  return JSON.stringify(
    {
      $schema: 'https://opencode.ai/config.json',
      provider: {
        llmweb2api: {
          npm: '@ai-sdk/openai-compatible',
          name: 'llmweb2api',
          options: {
            baseURL: baseUrl,
            apiKey,
          },
          models,
        },
      },
    },
    null,
    2,
  ) + '\\n';
}

function writeWithBackup(file, content) {
  const backupFile = file + '.llmweb2api.bak';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && !fs.existsSync(backupFile)) {
    fs.copyFileSync(file, backupFile);
    console.log('Backed up existing config to ' + backupFile);
  }
  fs.writeFileSync(file, content, 'utf8');
  console.log('Wrote ' + file);
}

for (const item of getTargetFiles()) {
  writeWithBackup(item.file, item.content);
}
console.log('Configured ' + tool + ' for API base URL: ' + baseUrl);
console.log('Requests will use endpoint: ' + endpointUrl);
console.log('Revert: ' + revertCommand);`;
  }

  function buildRevertCommand(): string {
    const script =
      selectedCli === 'codex'
        ? "const fs=require('fs'),os=require('os'),path=require('path');for(const file of [path.join(os.homedir(),'.codex','config.toml'),path.join(os.homedir(),'.codex','auth.json')]){const bak=file+'.llmweb2api.bak';if(fs.existsSync(bak)){fs.copyFileSync(bak,file);fs.rmSync(bak);console.log('Restored '+file)}else if(fs.existsSync(file)){fs.rmSync(file);console.log('Removed '+file)}else{console.log('Nothing to revert for '+file)}}"
        : "const fs=require('fs'),os=require('os'),path=require('path');const root=process.platform==='win32'?(process.env.APPDATA||path.join(os.homedir(),'AppData','Roaming')):(process.env.XDG_CONFIG_HOME||path.join(os.homedir(),'.config'));const file=path.join(root,'opencode','opencode.json');const bak=file+'.llmweb2api.bak';if(fs.existsSync(bak)){fs.copyFileSync(bak,file);fs.rmSync(bak);console.log('Restored '+file)}else if(fs.existsSync(file)){fs.rmSync(file);console.log('Removed '+file)}else{console.log('Nothing to revert')}";
    return buildNodeCommand(script);
  }

  function buildNodeCommand(script: string): string {
    return `node -e "eval(Buffer.from('${btoa(script)}','base64').toString('utf8'))"`;
  }

  function buildCliConfigTargetLabel(): string {
    if (selectedCli === 'codex') return '~/.codex/config.toml and ~/.codex/auth.json';
    return 'Windows: %APPDATA%\\opencode\\opencode.json, macOS/Linux: ~/.config/opencode/opencode.json';
  }

  function buildManualCliConfig(): string {
    const selectedKey = apiKeys.find((key) => String(key.id) === selectedApiKeyId);
    const apiKey = selectedKey?.key || '<select-api-key>';
    const baseUrl = getCliApiBaseUrl();
    const providerModels = modelMaps.availableProviderModels.length
      ? modelMaps.availableProviderModels
      : DEFAULT_PROVIDER_MODELS;
    const defaultModel = providerModels[0] || 'deepseek-v4-flash';

    if (selectedCli === 'codex') {
      return [
        'File: ~/.codex/config.toml',
        '',
        `model = ${JSON.stringify(defaultModel)}`,
        'model_provider = "llmweb2api"',
        'cli_auth_credentials_store = "file"',
        '',
        '# Codex calls POST ' + baseUrl + '/responses because wire_api is responses.',
        '[model_providers.llmweb2api]',
        'name = "llmweb2api"',
        `base_url = ${JSON.stringify(baseUrl)}`,
        'wire_api = "responses"',
        'requires_openai_auth = true',
        '',
        'File: ~/.codex/auth.json',
        '',
        JSON.stringify({ OPENAI_API_KEY: apiKey, auth_mode: 'apikey' }, null, 2),
      ].join('\n');
    }

    const models = Object.fromEntries(
      providerModels.map((model) => [
        model,
        {
          name: model,
          modalities: {
            input: ['text', 'image'],
            output: ['text'],
          },
          limit: {
            output: 32000,
            context: 480000,
          },
          options: {
            thinking: {
              type: 'enabled',
            },
          },
          compaction: {
            threshold: 0.8,
          },
        },
      ]),
    );

    return [
      `File: ${buildCliConfigTargetLabel()}`,
      '',
      JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          provider: {
            llmweb2api: {
              npm: '@ai-sdk/openai-compatible',
              name: 'llmweb2api',
              options: {
                baseURL: baseUrl,
                apiKey,
              },
              models,
            },
          },
        },
        null,
        2,
      ),
    ].join('\n');
  }

  async function copyCliSnippet() {
    await navigator.clipboard.writeText(buildCliSnippet());
    setCopiedCliSnippet(true);
    setTimeout(() => setCopiedCliSnippet(false), 2000);
  }

  async function copyRevertCommand() {
    await navigator.clipboard.writeText(buildRevertCommand());
    setCopiedRevertCommand(true);
    setTimeout(() => setCopiedRevertCommand(false), 2000);
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
            <CardTitle>CLI Configuration</CardTitle>
            <CardDescription>
              Generate a shell command that writes native OpenAI-compatible CLI config files
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="cli-tool">CLI Tool</Label>
                <Select value={selectedCli} onValueChange={(value) => setSelectedCli(value as CliTool)}>
                  <SelectTrigger id="cli-tool">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CLI_TOOLS.map((tool) => (
                      <SelectItem key={tool.key} value={tool.key}>
                        {tool.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="cli-api-key">API Key</Label>
                <Select value={selectedApiKeyId} onValueChange={setSelectedApiKeyId}>
                  <SelectTrigger id="cli-api-key">
                    <SelectValue placeholder="Select an API key" />
                  </SelectTrigger>
                  <SelectContent>
                    {apiKeys.map((key) => (
                      <SelectItem key={key.id} value={String(key.id)}>
                        {key.name} {key.enabled ? '' : '(disabled)'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <Terminal className="h-4 w-4" />
              <span>
                Generated config writes <code>{buildCliConfigTargetLabel()}</code> and points it at{' '}
                <code>{getCliEndpointUrl(selectedCli)}</code>.
              </span>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="cli-snippet">CMD / Bash command</Label>
              <Textarea
                id="cli-snippet"
                className="min-h-[120px] font-mono text-xs"
                readOnly
                value={buildCliSnippet()}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="cli-manual-config">Manual setup</Label>
              <Textarea
                id="cli-manual-config"
                className="min-h-[220px] font-mono text-xs"
                readOnly
                value={buildManualCliConfig()}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="cli-revert-command">Revert command</Label>
              <div className="flex gap-2">
                <Input id="cli-revert-command" readOnly value={buildRevertCommand()} className="font-mono text-xs" />
                <Button variant="outline" size="icon" onClick={copyRevertCommand}>
                  {copiedRevertCommand ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>

            <Button variant="outline" onClick={copyCliSnippet} disabled={!selectedApiKeyId}>
              {copiedCliSnippet ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
              Copy Snippet
            </Button>
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
