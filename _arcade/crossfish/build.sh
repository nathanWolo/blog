#!/usr/bin/env bash
# Build the crossfish engine as a standalone WebAssembly reactor module (no JavaScript glue) and put it
# where the site serves it from. Run inside WSL (or any Linux with Emscripten):
#   ./build.sh /path/to/crossfish-checkout            (or: CROSSFISH_DIR=... ./build.sh)
# Options: --any-commit  skip the pinned-commit check;  --test  also export cf_test_* (parity tests,
# written to $CF_BUILD_DIR/crossfish-test.wasm, never copied to the site).
# Env: EMSDK (default /opt/emsdk), CF_BUILD_DIR (default $HOME/crossfish-build; keep it out of the
# cloud-synced website folder).
set -euo pipefail
PINNED=219f0f8      # upstream commit this build was verified against (see README.md)
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${CROSSFISH_DIR:-}"; ANY=0; TEST=0
for a in "$@"; do
  case "$a" in
    --any-commit) ANY=1 ;;
    --test) TEST=1 ;;
    *) SRC="$a" ;;
  esac
done
[ -n "$SRC" ] || { echo "usage: $0 <crossfish checkout> [--any-commit] [--test]" >&2; exit 1; }
SRC="$(cd "$SRC" && pwd)"
[ -f "$SRC/cpp_impl/codingame_nnue.cpp" ] || { echo "no cpp_impl/codingame_nnue.cpp in $SRC" >&2; exit 1; }
# -c safe.directory: the checkout may be owned by another user (e.g. a Windows drive seen from WSL).
HEAD="$(git -c safe.directory='*' -C "$SRC" rev-parse HEAD 2>/dev/null || echo unknown)"
if [ "$ANY" = 0 ] && [ "${HEAD#$PINNED}" = "$HEAD" ]; then
  echo "checkout HEAD is $HEAD, expected $PINNED (pass --any-commit to build anyway)" >&2; exit 1
fi
source "${EMSDK:-/opt/emsdk}/emsdk_env.sh" >/dev/null
OUT="${CF_BUILD_DIR:-$HOME/crossfish-build}"; mkdir -p "$OUT"

EXPORTS="_cf_new,_cf_play,_cf_think,_cf_legal,_cf_cell,_cf_board_state,_cf_winner,_cf_to_move,_cf_last_depth,_cf_last_nodes,_cf_last_score"
DEFS=""; NAME=crossfish.wasm
if [ "$TEST" = 1 ]; then
  EXPORTS="$EXPORTS,_cf_test_fixed_depth,_cf_test_fresh_engine"; DEFS="-DCF_TEST"; NAME=crossfish-test.wasm
fi
# -mavx2 (+ -msimd128): Emscripten's AVX2 headers emulate the _mm256_* intrinsics with wasm SIMD.
# -ffp-contract=off: the macro net's table bake must stay bit-exact with the native build (no FMA).
# No -ffast-math. STANDALONE_WASM + --no-entry: a WASI reactor that exports _initialize.
em++ -O3 -std=c++17 -msimd128 -mavx2 -ffp-contract=off $DEFS \
  -Wno-unknown-pragmas -Wno-ignored-attributes -I"$SRC/cpp_impl" \
  "$HERE/wasm_api.cpp" -o "$OUT/$NAME" \
  -sSTANDALONE_WASM --no-entry \
  -sEXPORTED_FUNCTIONS="$EXPORTS" \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=41943040 -sSTACK_SIZE=2097152 \
  -sFILESYSTEM=0 -sERROR_ON_UNDEFINED_SYMBOLS=1
ls -l "$OUT/$NAME"
if [ "$TEST" = 0 ]; then
  mkdir -p "$HERE/../../assets/wasm"
  cp "$OUT/$NAME" "$HERE/../../assets/wasm/crossfish.wasm"
  ls -l "$HERE/../../assets/wasm/crossfish.wasm"
fi
