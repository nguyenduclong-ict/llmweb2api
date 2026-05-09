# Build Go WASM module for PoW computation
# Prerequisites: Go 1.21+ installed
# Usage: bash scripts/build-pow-wasm.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
POW_DIR="$PROJECT_DIR/src/providers/deepseek/pow_go"

echo "==> Building Go WASM for PoW..."

cd "$POW_DIR"

GOOS=js GOARCH=wasm go build -o pow.wasm .

# Copy wasm_exec.js from Go installation (path varies by Go version)
GOROOT=$(go env GOROOT)
WASM_EXEC="$GOROOT/lib/wasm/wasm_exec.js"          # Go 1.24+
if [ ! -f "$WASM_EXEC" ]; then
  WASM_EXEC="$GOROOT/misc/wasm/wasm_exec.js"        # Go <1.24
fi

if [ -f "$WASM_EXEC" ]; then
  cp "$WASM_EXEC" "$POW_DIR/wasm_exec.js"
  echo "==> Copied wasm_exec.js from $WASM_EXEC"
else
  echo "ERROR: wasm_exec.js not found at $GOROOT/lib/wasm/ or $GOROOT/misc/wasm/"
  exit 1
fi

# Also copy to the build output location expected by the TS loader
echo "==> Build complete: pow.wasm + wasm_exec.js"
ls -la "$POW_DIR/pow.wasm" "$POW_DIR/wasm_exec.js"
