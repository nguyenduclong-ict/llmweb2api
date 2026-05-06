# Build Go WASM module for PoW computation (Windows)
# Prerequisites: Go 1.21+ installed
# Usage: .\scripts\build-pow-wasm.ps1

$ErrorActionPreference = "Stop"

$projectDir = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$powDir = Join-Path $projectDir "src\providers\deepseek\pow_go"

Write-Host "==> Building Go WASM for PoW..."

Push-Location $powDir
try {
  $env:GOOS = "js"
  $env:GOARCH = "wasm"
  go build -o pow.wasm .

  # Copy wasm_exec.js from Go installation (path varies by Go version)
  $goroot = go env GOROOT
  $wasmExec = Join-Path $goroot "lib\wasm\wasm_exec.js"       # Go 1.24+
  if (-not (Test-Path $wasmExec)) {
    $wasmExec = Join-Path $goroot "misc\wasm\wasm_exec.js"    # Go <1.24
  }

  if (Test-Path $wasmExec) {
    Copy-Item $wasmExec -Destination "$powDir\wasm_exec.js" -Force
    Write-Host "==> Copied wasm_exec.js from $wasmExec"
  } else {
    Write-Host "ERROR: wasm_exec.js not found at $goroot\lib\wasm\ or $goroot\misc\wasm\"
    exit 1
  }

  Write-Host "==> Build complete!"
  Get-ChildItem "$powDir\pow.wasm", "$powDir\wasm_exec.js" | ForEach-Object {
    Write-Host "  $($_.Name)  $($_.Length) bytes"
  }
} finally {
  Pop-Location
}
