import * as fs from 'fs';
import * as path from 'path';

// Kết quả trả về từ PoW WASM solver
interface PowResult {
  answer: number;
}

interface PowError {
  error: string;
}

// ---- WASM initialization (singleton) ----

let ready = false;
let initPromise: Promise<void> | null = null;

/**
 * Khởi tạo Go WASM runtime.
 * Được gọi tự động lần đầu solvePow() hoặc buildHeader() được gọi.
 */
export async function initPowWasm(): Promise<void> {
  if (ready) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const powDir = __dirname;
    const wasmPath = path.join(powDir, 'pow_go', 'pow.wasm');
    const wasmExecPath = path.join(powDir, 'pow_go', 'wasm_exec.js');

    if (!fs.existsSync(wasmPath) || !fs.existsSync(wasmExecPath)) {
      throw new Error(
        `PoW WASM not found. Run "pnpm run build-pow" to build the Go WASM module.\n` +
          `Expected: ${wasmPath}\n` +
          `Expected: ${wasmExecPath}`,
      );
    }

    // Load Go's WASM executor (sets globalThis.Go)
    require(wasmExecPath);

    const go = new (globalThis as any).Go();
    const wasmBytes = fs.readFileSync(wasmPath);
    const { instance } = await (globalThis as any).WebAssembly.instantiate(wasmBytes, go.importObject);

    // Chạy Go main() trong background - đăng ký global functions rồi block
    go.run(instance);

    // Đợi cho Go runtime khởi tạo xong và đăng ký các global functions
    let waited = 0;
    while (!(globalThis as any).__powSolvePow && waited < 100) {
      await new Promise((r) => setTimeout(r, 10));
      waited++;
    }

    if (!(globalThis as any).__powSolvePow) {
      throw new Error('Go WASM PoW module failed to initialize');
    }

    ready = true;
  })();

  return initPromise;
}

/**
 * Giải PoW challenge, trả về answer (nonce).
 * Hàm này chạy đồng bộ sau khi WASM đã được khởi tạo.
 */
export function solvePow(
  challengeHex: string,
  salt: string,
  expireAt: number,
  difficulty: number,
): number {
  const fn = (globalThis as any).__powSolvePow;
  if (!fn) throw new Error('__powSolvePow not registered, call initPowWasm() first');

  const raw = fn(challengeHex, salt, expireAt, difficulty) as string;
  const result: PowResult | PowError = JSON.parse(raw);

  if ('error' in result) {
    throw new Error(`PoW solve failed: ${result.error}`);
  }

  return (result as PowResult).answer;
}

/**
 * Tạo x-ds-pow-response header (base64 encoded JSON).
 */
export function buildPowHeader(
  algorithm: string,
  challenge: string,
  salt: string,
  answer: number,
  signature: string,
  targetPath: string,
): string {
  const fn = (globalThis as any).__powBuildHeader;
  if (!fn) throw new Error('__powBuildHeader not registered, call initPowWasm() first');

  const raw = fn(algorithm, challenge, salt, answer, signature, targetPath) as string;

  // __powBuildHeader trả về JSON string {"error":"..."} nếu lỗi, hoặc base64 string nếu thành công
  if (raw.startsWith('{')) {
    const err: PowError = JSON.parse(raw);
    throw new Error(`PoW build header failed: ${err.error}`);
  }

  return raw;
}

/**
 * Kiểm tra WASM module có sẵn sàng không.
 */
export function isPowWasmAvailable(): boolean {
  const powDir = __dirname;
  return (
    fs.existsSync(path.join(powDir, 'pow_go', 'pow.wasm')) &&
    fs.existsSync(path.join(powDir, 'pow_go', 'wasm_exec.js'))
  );
}
