#!/usr/bin/env bash
# Check that Emscripten builds the same engine as the native compiler, with upstream's own
# fingerprint (cpp_impl/cg_selfcheck.cpp): 120 fixed positions searched to a fixed depth must give
# the same node count and checksum from the native build and from the WebAssembly build run under
# Node. This is step 2 of "Moving to a newer upstream commit" in README.md; the arcade-engines
# workflow runs it before it accepts a newer upstream commit.
#   ./check.sh /path/to/crossfish-checkout            (or: CROSSFISH_DIR=... ./check.sh)
# Env: EMSDK (default /opt/emsdk), CF_BUILD_DIR (default $HOME/crossfish-build; the binaries go to
# its selfcheck/ folder), CXX (default g++; the shim reproduces libstdc++, so use GCC 11 or newer),
# CF_CHECK_DEPTHS (default "5 7 9 11").
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${1:-${CROSSFISH_DIR:-}}"
[ -n "$SRC" ] || { echo "usage: $0 <crossfish checkout>" >&2; exit 1; }
SRC="$(cd "$SRC" && pwd)"
[ -f "$SRC/cpp_impl/cg_selfcheck.cpp" ] || { echo "no cpp_impl/cg_selfcheck.cpp in $SRC" >&2; exit 1; }
OUT="${CF_BUILD_DIR:-$HOME/crossfish-build}/selfcheck"; mkdir -p "$OUT"

# Native: the flags of upstream's cpp_impl/Makefile.
"${CXX:-g++}" -O3 -std=c++17 -mavx2 -mbmi -mbmi2 -mlzcnt -mpopcnt -pthread \
  -Wno-unknown-pragmas -Wno-ignored-attributes \
  -o "$OUT/cg_selfcheck_native" "$SRC/cpp_impl/cg_selfcheck.cpp"

# WebAssembly, for Node: the flags of build.sh, with the same shim in front of upstream's source.
source "${EMSDK:-/opt/emsdk}/emsdk_env.sh" >/dev/null 2>&1
em++ -O3 -std=c++17 -msimd128 -mavx2 -ffp-contract=off \
  -Wno-unknown-pragmas -Wno-ignored-attributes -I"$SRC/cpp_impl" -I"$HERE" -include cf_stdlib_shim.hpp \
  "$SRC/cpp_impl/cg_selfcheck.cpp" -o "$OUT/cg_selfcheck_wasm.js" \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=50331648 -sSTACK_SIZE=2097152 -sENVIRONMENT=node

for depth in ${CF_CHECK_DEPTHS:-5 7 9 11}; do
  # The first line carries positions, depth, nodes and checksum; the others are timings and the book.
  native="$("$OUT/cg_selfcheck_native" 120 "$depth")"; native="${native%%$'\n'*}"
  wasm="$(node "$OUT/cg_selfcheck_wasm.js" 120 "$depth")"; wasm="${wasm%%$'\n'*}"
  case "$native" in
    *"positions=120 depth=$depth nodes="*"checksum="*) ;;
    *) echo "crossfish check: unexpected output from the native cg_selfcheck: $native" >&2; exit 1 ;;
  esac
  if [ "$native" != "$wasm" ]; then
    echo "crossfish check: at depth $depth the WebAssembly build searches a different tree from the native build" >&2
    echo "  native: $native" >&2
    echo "  wasm:   $wasm" >&2
    exit 1
  fi
  echo "depth $depth: identical ($native)"
done
