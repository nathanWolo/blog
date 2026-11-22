#!/usr/bin/env bash
# Check wasm_api.cpp against a cgpoker checkout, natively: build check_split.cpp (see its header) and
# run it. It fails if the copy of upstream's game_turn in wasm_api.cpp no longer plays as upstream's
# own Engine::run does. The arcade-engines workflow runs it before it accepts a newer upstream commit.
#   ./check.sh /path/to/cgpoker-checkout              (or: CGPOKER_DIR=... ./check.sh)
# Env: CXX (default g++), OUT_DIR (where the binary goes; default a temporary folder),
# PK_CHECK_GAMES (games per table size, default 20).
set -euo pipefail
cd "$(dirname "$0")"
CG="${1:-${CGPOKER_DIR:-}}"
[ -n "$CG" ] || { echo "usage: $0 /path/to/cgpoker   (or set CGPOKER_DIR)" >&2; exit 1; }
CG="$(cd "$CG" && pwd)"
[ -f "$CG/engine/poker_engine.hpp" ] || { echo "$CG is not a cgpoker checkout (missing engine/poker_engine.hpp)" >&2; exit 1; }
OUT="${OUT_DIR:-$(mktemp -d)}"; mkdir -p "$OUT"

"${CXX:-g++}" -std=c++20 -O2 -pthread -w -I"$CG" -o "$OUT/check_split" check_split.cpp
"$OUT/check_split" "${PK_CHECK_GAMES:-20}"
