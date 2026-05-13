type ProcessValue = string | number | string[] | OrderedMap | ((...args: any[]) => void) | undefined;

class OrderedMap {
  readonly keys: string[] = [];
  readonly values: Record<string, unknown> = {};

  add(key: string, value: unknown): void {
    if (!(key in this.values)) this.keys.push(key);
    this.values[key] = value;
  }
}

export function solveTurnstileToken(dx: string, p: string): string | undefined {
  let tokenList: unknown;
  try {
    const decoded = Buffer.from(dx, 'base64').toString();
    tokenList = JSON.parse(xorString(decoded, p));
  } catch {
    return undefined;
  }
  if (!Array.isArray(tokenList)) return undefined;

  const processMap = new Map<number, ProcessValue>();
  const start = Date.now();
  let result = '';

  const read = (key: number): ProcessValue => processMap.get(key);
  const write = (key: number, value: ProcessValue): void => {
    processMap.set(key, value);
  };

  processMap.set(1, (e: number, t: number) =>
    write(e, xorString(toTurnstileString(read(e)), toTurnstileString(read(t)))),
  );
  processMap.set(2, (e: number, t: ProcessValue) => write(e, t));
  processMap.set(3, (e: string) => {
    result = Buffer.from(e).toString('base64');
  });
  processMap.set(5, (e: number, t: number) => {
    const current = read(e);
    const incoming = read(t);
    if (Array.isArray(current)) {
      write(e, [...current, incoming as string]);
      return;
    }
    if (
      typeof current === 'string' ||
      typeof current === 'number' ||
      typeof incoming === 'string' ||
      typeof incoming === 'number'
    ) {
      write(e, toTurnstileString(current) + toTurnstileString(incoming));
      return;
    }
    write(e, 'NaN');
  });
  processMap.set(6, (e: number, t: number, n: number) => {
    const value = `${toTurnstileString(read(t))}.${toTurnstileString(read(n))}`;
    write(e, value === 'window.document.location' ? 'https://chatgpt.com/' : value);
  });
  processMap.set(7, (e: number, ...args: number[]) => {
    const target = read(e);
    const values = args.map((arg) => read(arg));
    if (target === 'window.Reflect.set') {
      const [obj, key, value] = values;
      if (obj instanceof OrderedMap) obj.add(String(key), value);
    } else if (typeof target === 'function') {
      target(...(values as number[]));
    }
  });
  processMap.set(8, (e: number, t: number) => write(e, read(t)));
  processMap.set(14, (e: number, t: number) => {
    try {
      write(e, JSON.parse(toTurnstileString(read(t))) as ProcessValue);
    } catch {
      write(e, undefined);
    }
  });
  processMap.set(15, (e: number, t: number) => write(e, JSON.stringify(read(t))));
  processMap.set(17, (e: number, t: number, ...args: number[]) => {
    const target = read(t);
    const callArgs = args.map((arg) => read(arg));
    if (target === 'window.performance.now') {
      write(e, Date.now() - start + Math.random());
    } else if (target === 'window.Object.create') {
      write(e, new OrderedMap());
    } else if (target === 'window.Object.keys') {
      if (callArgs[0] === 'window.localStorage') {
        write(e, [
          'STATSIG_LOCAL_STORAGE_INTERNAL_STORE_V4',
          'STATSIG_LOCAL_STORAGE_STABLE_ID',
          'client-correlated-secret',
          'oai/apps/capExpiresAt',
          'oai-did',
        ]);
      }
    } else if (target === 'window.Math.random') {
      write(e, Math.random());
    } else if (typeof target === 'function') {
      write(e, target(...(callArgs as number[])) as ProcessValue);
    }
  });
  processMap.set(18, (e: number) => write(e, Buffer.from(toTurnstileString(read(e)), 'base64').toString()));
  processMap.set(19, (e: number) => write(e, Buffer.from(toTurnstileString(read(e))).toString('base64')));
  processMap.set(20, (e: number, t: number, n: number, ...args: number[]) => {
    const target = read(n);
    if (read(e) === read(t) && typeof target === 'function') target(...args);
  });
  processMap.set(21, () => undefined);
  processMap.set(23, (e: number, t: number, ...args: number[]) => {
    const target = read(t);
    if (read(e) !== undefined && typeof target === 'function') target(...args);
  });
  processMap.set(24, (e: number, t: number, n: number) =>
    write(e, `${toTurnstileString(read(t))}.${toTurnstileString(read(n))}`),
  );
  processMap.set(9, tokenList as ProcessValue);
  processMap.set(10, 'window');
  processMap.set(16, p);

  for (const item of tokenList) {
    if (!Array.isArray(item)) continue;
    try {
      const [op, ...args] = item as number[];
      const fn = processMap.get(op);
      if (typeof fn === 'function') fn(...args);
    } catch {
      continue;
    }
  }

  return result || undefined;
}

function toTurnstileString(value: ProcessValue): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return Array.isArray(value) ? value.join(',') : String(value);
  return (
    {
      'window.Math': '[object Math]',
      'window.Reflect': '[object Reflect]',
      'window.performance': '[object Performance]',
      'window.localStorage': '[object Storage]',
      'window.Object': 'function Object() { [native code] }',
      'window.Reflect.set': 'function set() { [native code] }',
      'window.performance.now': 'function () { [native code] }',
      'window.Object.create': 'function create() { [native code] }',
      'window.Object.keys': 'function keys() { [native code] }',
      'window.Math.random': 'function random() { [native code] }',
    }[value] || value
  );
}

function xorString(text: string, key: string): string {
  if (!key) return text;
  return [...text].map((ch, i) => String.fromCharCode(ch.charCodeAt(0) ^ key.charCodeAt(i % key.length))).join('');
}
