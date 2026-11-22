#!/usr/bin/env bash
# Build the masthead engine and put it where the site serves it from.
# Needs Rust with the wasm target: rustup target add wasm32-unknown-unknown
set -euo pipefail
cd "$(dirname "$0")"

cargo build --release --target wasm32-unknown-unknown
mkdir -p ../assets/wasm
cp target/wasm32-unknown-unknown/release/tron_masthead.wasm ../assets/wasm/tron.wasm
ls -l ../assets/wasm/tron.wasm
