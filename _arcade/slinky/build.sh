#!/usr/bin/env bash
# Build the AlphaSlinky engine as WebAssembly (WASI reactor) and put it where the site serves it from.
# Needs Rust with the wasip1 target: rustup target add wasm32-wasip1
# Honours CARGO_TARGET_DIR (keep it out of the cloud-synced website folder).
# The page must call the module's `_initialize` export once before any bs_* call, and supply the
# wasi_snapshot_preview1 imports (see README.md).
set -euo pipefail
cd "$(dirname "$0")"

# simd128: lets LLVM vectorise (every current browser supports it).
#
# The page calls the module's `_initialize` export once before anything else. It comes from
# wasi-libc's reactor start-up object, crt1-reactor.o, which ships with the wasm32-wasip1 target.
# Rust 1.97 leaves that object out of a cdylib, so it has to be named; Rust 1.100 links it by
# itself, and naming it as well is a "duplicate symbol" error. So: name it, and if that is the
# error, build again without. (_arcade/check_wasm.mjs checks that the export is there.)
REACTOR="$(rustc --print sysroot)/lib/rustlib/wasm32-wasip1/lib/self-contained/crt1-reactor.o"
[ -f "$REACTOR" ] || { echo "missing $REACTOR (rustup target add wasm32-wasip1)" >&2; exit 1; }
FLAGS="-C target-feature=+simd128"
LOG="$(mktemp)"
if RUSTFLAGS="$FLAGS -C link-arg=$REACTOR" cargo build --release --target wasm32-wasip1 2> "$LOG"; then
  cat "$LOG" >&2
elif grep -q "duplicate symbol: _initialize" "$LOG"; then
  echo "This rustc links crt1-reactor.o by itself: building without naming it." >&2
  RUSTFLAGS="$FLAGS" cargo build --release --target wasm32-wasip1
else
  cat "$LOG" >&2
  exit 1
fi
TARGET_DIR="${CARGO_TARGET_DIR:-target}"
mkdir -p ../../assets/wasm
cp "$TARGET_DIR/wasm32-wasip1/release/slinky_arcade.wasm" ../../assets/wasm/slinky.wasm
ls -l ../../assets/wasm/slinky.wasm
