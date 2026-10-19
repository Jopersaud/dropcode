#!/usr/bin/env sh
# Copy shared assets into the Go module (go:embed cannot reach outside it).
# Tests in cli/internal/{pake,words} fail if the copies drift.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
cp "$root/shared/pake.wasm" "$root/cli/internal/pake/pake.wasm"
cp "$root/shared/wordlist.txt" "$root/cli/internal/words/wordlist.txt"
