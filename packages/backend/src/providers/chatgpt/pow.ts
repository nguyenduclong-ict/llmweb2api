import crypto from 'crypto';
import { randomUUID } from 'crypto';

const DEFAULT_POW_SCRIPT = 'https://chatgpt.com/backend-api/sentinel/sdk.js';
const CORES = [8, 16, 24, 32];
const DOCUMENT_KEYS = ['_reactListeningo743lnnpvdg', 'location'];

export function parsePowResources(html: string): { scriptSources: string[]; dataBuild: string } {
  const scriptSources = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map((match) => match[1]);
  let dataBuild = '';
  for (const src of scriptSources) {
    const match = src.match(/c\/[^/]*\/_/);
    if (match) {
      dataBuild = match[0];
      break;
    }
  }
  if (!dataBuild) {
    dataBuild = html.match(/<html[^>]*data-build=["']([^"']*)["']/i)?.[1] || '';
  }
  return { scriptSources: scriptSources.length ? scriptSources : [DEFAULT_POW_SCRIPT], dataBuild };
}

export function buildLegacyRequirementsToken(
  userAgent: string,
  scriptSources: string[] = [DEFAULT_POW_SCRIPT],
  dataBuild = '',
): string {
  const seed = String(Math.random());
  const config = buildPowConfig(userAgent, scriptSources, dataBuild);
  return `gAAAAAC${powGenerate(seed, '0fffff', config, false)}`;
}

export function buildProofToken(
  seed: string,
  difficulty: string,
  userAgent: string,
  scriptSources: string[] = [DEFAULT_POW_SCRIPT],
  dataBuild = '',
): string {
  const config = buildPowConfig(userAgent, scriptSources, dataBuild);
  return `gAAAAAB${powGenerate(seed, difficulty, config, true)}`;
}

function buildPowConfig(userAgent: string, scriptSources: string[], dataBuild: string): unknown[] {
  return [
    randomChoice([3000, 4000, 5000]),
    legacyTimeString(),
    4294705152,
    0,
    userAgent,
    randomChoice(scriptSources),
    dataBuild,
    'vi-VN',
    'vi-VN,en-US,vi,fr-FR,fr,en',
    0,
    randomChoice([
      'registerProtocolHandler−function registerProtocolHandler() { [native code] }',
      'storage−[object StorageManager]',
      'locks−[object LockManager]',
      'webdriver−false',
      'vendor−Google Inc.',
      'cookieEnabled−true',
      'product−Gecko',
      'onLine−true',
      'hardwareConcurrency−32',
      'language−vi-VN',
    ]),
    randomChoice(DOCUMENT_KEYS),
    randomChoice([
      'window',
      'self',
      'document',
      'location',
      'history',
      'navigator',
      'performance',
      'crypto',
      'fetch',
      'screenX',
      'screenY',
      'innerWidth',
      'innerHeight',
    ]),
    performance.now(),
    randomUUID(),
    '',
    randomChoice(CORES),
    Date.now() - performance.now(),
  ];
}

function powGenerate(seed: string, difficulty: string, config: unknown[], requireSolved: boolean): string {
  const target = Buffer.from(difficulty, 'hex');
  const diffLen = Math.floor(difficulty.length / 2);
  const seedBytes = Buffer.from(seed);
  const static1 = Buffer.from(`${JSON.stringify(config.slice(0, 3)).slice(0, -1)},`);
  const static2 = Buffer.from(`,${JSON.stringify(config.slice(4, 9)).slice(1, -1)},`);
  const static3 = Buffer.from(`,${JSON.stringify(config.slice(10)).slice(1)}`);

  for (let i = 0; i < 500000; i++) {
    const finalJson = Buffer.concat([static1, Buffer.from(String(i)), static2, Buffer.from(String(i >> 1)), static3]);
    const encoded = finalJson.toString('base64');
    const digest = crypto
      .createHash('sha3-512')
      .update(Buffer.concat([seedBytes, Buffer.from(encoded)]))
      .digest();
    if (digest.subarray(0, diffLen).compare(target) <= 0) return encoded;
  }

  if (requireSolved) throw new Error(`failed to solve proof token: difficulty=${difficulty}`);
  return `wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D${Buffer.from(`"${seed}"`).toString('base64')}`;
}

function legacyTimeString(): string {
  return new Date().toString().replace(/\s\(.*\)$/, ' (Giờ Đông Dương)');
}

function randomChoice<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}
