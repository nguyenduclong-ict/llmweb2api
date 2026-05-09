const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'providers', 'deepseek', 'pow_go');
const DST = path.join(ROOT, 'dist', 'providers', 'deepseek', 'pow_go');

const files = ['pow.wasm', 'wasm_exec.js'];
let copied = 0;

fs.mkdirSync(DST, { recursive: true });

for (const f of files) {
  const src = path.join(SRC, f);
  const dst = path.join(DST, f);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
    copied++;
  }
}

if (copied > 0) {
  console.log(`[build] Copied ${copied} PoW asset(s) to dist/`);
}
