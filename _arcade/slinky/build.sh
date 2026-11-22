#!/usr/bin/env bash
# Build the AlphaSlinky engine as WebAssembly (WASI reactor) and put it where the site serves it from.
# Needs Rust with the wasip1 target: rustup target add wasm32-wasip1
# Honours CARGO_TARGET_DIR (keep it out of the cloud-synced website folder).
# The page must call the module's `_initialize` export once before any bs_* call, and supply the
# wasi_snapshot_preview1 imports (see README.md).
set -euo pipefail
cd "$(dirname "$0")"

# simd128: lets LLVM vectorise (every current browser supports it).
# crt1-reactor.o: rustc links a wasip1 cdylib without any C runtime entry, so it would export no
# `_initialize`. Linking wasi-libc's reactor start file (shipped with the wasm32-wasip1 target)
# makes the module export `_initialize`, which runs wasi-libc's constructors.
SYSROOT="$(rustc --print sysroot)"
REACTOR="$SYSROOT/lib/rustlib/wasm32-wasip1/lib/self-contained/crt1-reactor.o"
[ -f "$REACTOR" ] || { echo "missing $REACTOR (rustup target add wasm32-wasip1)" >&2; exit 1; }
RUSTFLAGS="-C target-feature=+simd128 -C link-arg=$REACTOR" cargo build --release --target wasm32-wasip1
TARGET_DIR="${CARGO_TARGET_DIR:-target}"
mkdir -p ../../assets/wasm
cp "$TARGET_DIR/wasm32-wasip1/release/slinky_arcade.wasm" ../../assets/wasm/slinky.wasm
ls -l ../../assets/wasm/slinky.wasm
