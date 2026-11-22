#!/usr/bin/env bash
# Build the cgpoker game + bot as a standalone WebAssembly reactor (no JavaScript glue) and put it where
# the site serves it from.  Run inside WSL/Linux:
#
#     ./build.sh /path/to/cgpoker-checkout            # or: CGPOKER_DIR=/path/to/cgpoker ./build.sh
#     ALLOW_ANY_COMMIT=1 ./build.sh /path/to/cgpoker  # build a checkout that is not the pinned commit
#
# Needs Emscripten (EMSDK, default /opt/emsdk). The page's loader instantiates the module itself, calls
# its `_initialize` export once and supplies the wasi_snapshot_preview1 imports (see README.md).
# Set OUT_DIR to keep the object/intermediate output out of the synced website folder.
set -euo pipefail
cd "$(dirname "$0")"

PINNED=3d8f74c   # https://github.com/nathanWolo/cgpoker
CG="${1:-${CGPOKER_DIR:-}}"
[ -n "$CG" ] || { echo "usage: $0 /path/to/cgpoker   (or set CGPOKER_DIR)" >&2; exit 1; }
CG="$(cd "$CG" && pwd)"
for f in engine/poker_engine.hpp bot/bot.hpp cpp/pe7c.hpp; do
  [ -f "$CG/$f" ] || { echo "$CG is not a cgpoker checkout (missing $f)" >&2; exit 1; }
done
HEAD="$(git -C "$CG" rev-parse HEAD 2>/dev/null || echo unknown)"
case "$HEAD" in
  $PINNED*) ;;
  *) if [ "${ALLOW_ANY_COMMIT:-0}" = 1 ]; then echo "warning: $CG is at $HEAD, not the pinned $PINNED" >&2
     else echo "$CG is at $HEAD, not the pinned $PINNED (set ALLOW_ANY_COMMIT=1 to build it anyway)" >&2; exit 1; fi ;;
esac

source "${EMSDK:-/opt/emsdk}/emsdk_env.sh" >/dev/null 2>&1

EXPORTS="_pk_init,_pk_new_game,_pk_step,_pk_act,_pk_next_hand,_pk_state_ptr,_pk_state_len,_pk_set_budget,_pk_error_ptr,_pk_error_len"
OUT="${OUT_DIR:-$(mktemp -d)}"
mkdir -p "$OUT" ../../assets/wasm

em++ -O2 -std=c++20 -fwasm-exceptions -w \
  -I"$CG" \
  wasm_api.cpp -o "$OUT/poker.wasm" \
  -sSTANDALONE_WASM=1 --no-entry \
  -sEXPORTED_FUNCTIONS="$EXPORTS" \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 \
  -sFILESYSTEM=0 -sASSERTIONS=0

cp "$OUT/poker.wasm" ../../assets/wasm/poker.wasm
ls -l ../../assets/wasm/poker.wasm
echo "built from cgpoker $HEAD"
