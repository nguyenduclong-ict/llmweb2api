const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const POW_DIR = path.join(ROOT, 'src', 'providers', 'deepseek', 'pow_go');
const WASM_FILE = path.join(POW_DIR, 'pow.wasm');
const WASM_EXEC_FILE = path.join(POW_DIR, 'wasm_exec.js');

function hasGo() {
  try {
    execSync('go version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function getWasmExecPath(goroot) {
  // Go 1.24+ uses lib/wasm, older versions use misc/wasm
  const candidates = [
    path.join(goroot, 'lib', 'wasm', 'wasm_exec.js'),
    path.join(goroot, 'misc', 'wasm', 'wasm_exec.js'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function build() {
  if (!hasGo()) {
    console.warn('[build-pow] Go not found — skipping WASM build. Install Go 1.21+ for fast PoW.');
    return false;
  }

  console.log('[build-pow] Building Go WASM module...');

  // Build WASM
  const env = { ...process.env, GOOS: 'js', GOARCH: 'wasm' };
  execSync('go build -o pow.wasm .', { cwd: POW_DIR, env, stdio: 'inherit' });

  // Copy wasm_exec.js
  const goroot = execSync('go env GOROOT', { encoding: 'utf-8' }).trim();
  const wasmExec = getWasmExecPath(goroot);

  if (!wasmExec) {
    console.error(`[build-pow] ERROR: wasm_exec.js not found in ${goroot}/lib/wasm/ or ${goroot}/misc/wasm/`);
    process.exit(1);
  }

  fs.copyFileSync(wasmExec, WASM_EXEC_FILE);
  console.log(`[build-pow] Copied wasm_exec.js from ${wasmExec}`);

  // Report
  const wasmSize = (fs.statSync(WASM_FILE).size / 1024 / 1024).toFixed(1);
  console.log(`[build-pow] Done: pow.wasm (${wasmSize} MB) + wasm_exec.js`);
  return true;
}

// Run directly
if (require.main === module) {
  build();
}

module.exports = { build, hasGo };
