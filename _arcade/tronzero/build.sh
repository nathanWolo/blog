#!/usr/bin/env bash
# Build the arcade engine for WebAssembly (WASI reactor) and put it where the site serves it from.
# Needs Rust with the wasm target: rustup target add wasm32-wasip1
# Set CARGO_TARGET_DIR to keep build output out of this (cloud-synced) folder.
set -euo pipefail
cd "$(dirname "$0")"

# A cdylib for wasip1 has no `_initialize` unless the reactor start-up object is linked in.
REACTOR="$(rustc --print sysroot)/lib/rustlib/wasm32-wasip1/lib/self-contained/crt1-reactor.o"
test -f "$REACTOR" || { echo "missing $REACTOR" >&2; exit 1; }
RUSTFLAGS="-C target-feature=+simd128 -C link-arg=$REACTOR" cargo build --release --target wasm32-wasip1
mkdir -p ../../assets/wasm
cp "${CARGO_TARGET_DIR:-target}/wasm32-wasip1/release/tronzero_arcade.wasm" ../../assets/wasm/tronzero.wasm
ls -l ../../assets/wasm/tronzero.wasm
