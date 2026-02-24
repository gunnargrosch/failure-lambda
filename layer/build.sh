#!/bin/bash
set -euo pipefail

# Determine build tool: cargo-zigbuild (no Docker) or cross (Docker/Finch)
# cargo-zigbuild replaces "cargo build" (no extra "build" subcommand),
# while cross uses "cross build".
if command -v cargo-zigbuild &> /dev/null; then
  BUILD_CMD="cargo zigbuild"
elif command -v cross &> /dev/null; then
  BUILD_CMD="cross build"
else
  echo "Error: neither 'cargo-zigbuild' nor 'cross' is installed."
  echo "Option 1: pip3 install ziglang && cargo install cargo-zigbuild"
  echo "Option 2: cargo install cross --git https://github.com/cross-rs/cross (requires Docker)"
  exit 1
fi

echo "Using build tool: $BUILD_CMD"

cd "$(dirname "$0")/proxy"

$BUILD_CMD --release --target x86_64-unknown-linux-musl
$BUILD_CMD --release --target aarch64-unknown-linux-musl

cd ..

# Build DNS intercept shared library (LD_PRELOAD .so for denylist).
# Targets glibc (Lambda's runtime libc), NOT musl. zig cc handles
# cross-compilation; it's available because cargo-zigbuild requires zig.
INTERCEPT_SRC="$(pwd)/dns-intercept/dns_intercept.c"
HAS_INTERCEPT=false

# Find zig — installed as Python package (pip3 install ziglang)
ZIG=""
if command -v zig &> /dev/null; then
  ZIG="zig"
else
  ZIG="$(python3 -c 'import ziglang, os; print(os.path.join(os.path.dirname(ziglang.__file__), "zig"))' 2>/dev/null || true)"
fi

if [ -n "$ZIG" ] && [ -f "$INTERCEPT_SRC" ]; then
  echo "Building DNS intercept .so with: $ZIG cc"
  "$ZIG" cc -shared -fPIC -o /tmp/dns-intercept-x86_64.so "$INTERCEPT_SRC" \
    -target x86_64-linux-gnu -ldl
  "$ZIG" cc -shared -fPIC -o /tmp/dns-intercept-aarch64.so "$INTERCEPT_SRC" \
    -target aarch64-linux-gnu -ldl
  HAS_INTERCEPT=true
else
  echo "WARNING: zig not found or dns_intercept.c missing — denylist will not work"
fi

for arch in x86_64 aarch64; do
  target="${arch}-unknown-linux-musl"
  dir="dist/${arch}"
  mkdir -p "$dir"
  cp "proxy/target/${target}/release/failure-lambda-proxy" "$dir/"
  cp wrapper "$dir/failure-lambda-wrapper"
  if [ "$HAS_INTERCEPT" = true ]; then
    cp "/tmp/dns-intercept-${arch}.so" "$dir/failure-lambda-dns-intercept.so"
    chmod +x "$dir/failure-lambda-dns-intercept.so"
  fi
  chmod +x "$dir/failure-lambda-proxy" "$dir/failure-lambda-wrapper"
  # Pre-built zips for manual layer publishing via AWS CLI:
  #   aws lambda publish-layer-version --layer-name failure-lambda \
  #     --zip-file fileb://dist/failure-lambda-layer-x86_64.zip ...
  # The SAM template (template.yaml) uses ContentUri pointing to the directory
  # instead, since SAM handles zipping during deployment.
  (cd "$dir" && zip -r "../failure-lambda-layer-${arch}.zip" .)
done

echo "Layer zips created:"
ls -lh dist/failure-lambda-layer-*.zip
