#!/usr/bin/env sh
# Rebuild the shared SPAKE2 WebAssembly module from pake/ and copy it to the
# places that embed it. The output is committed so that building the web
# client or the Go CLI does not require a Rust toolchain.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root/pake"
RUSTFLAGS="--remap-path-prefix=$root=/dropcode --remap-path-prefix=$HOME=/home" \
  cargo build --locked --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/dropcode_pake.wasm "$root/shared/pake.wasm"
mkdir -p "$root/cli/internal/pake"
cp "$root/shared/pake.wasm" "$root/cli/internal/pake/pake.wasm"
sha256sum "$root/shared/pake.wasm"
