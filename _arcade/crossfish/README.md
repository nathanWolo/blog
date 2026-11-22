# crossfish (WebAssembly)

The site owner's Ultimate Tic-Tac-Toe engine "crossfish" (alpha-beta search with an NNUE evaluation, written for
CodinGame) as a standalone WebAssembly module, so a visitor can play it in the browser (in a Web Worker).

The engine is upstream, unmodified: <https://github.com/nathanWolo/crossfish>, file `cpp_impl/codingame_nnue.cpp`,
verified against commit `219f0f8`. Nothing of upstream is copied here: `wasm_api.cpp` `#include`s it from a
checkout given at build time (its `main` is renamed with `#define main`). `wasm_api.cpp` adds one static game, one
heap engine and a C ABI; `cf_stdlib_shim.hpp` is the only other file (see "Shim" below).

Rules are CodinGame's variant (as implemented upstream): a move sent to a decided or full small board gives a free
move; a full big board with no line is decided by who won more small boards, a draw only when equal.

## Rebuild

Inside WSL / Linux with Emscripten (tested: emsdk 7.0.1):

```bash
cd _arcade/crossfish
git clone https://github.com/nathanWolo/crossfish /root/crossfish && git -C /root/crossfish checkout 219f0f8
./build.sh /root/crossfish        # or CROSSFISH_DIR=/root/crossfish ./build.sh
# -> ../../assets/wasm/crossfish.wasm  (about 250 KB)
```

`build.sh` refuses a checkout whose HEAD is not the pinned commit (`--any-commit` overrides), sources
`$EMSDK/emsdk_env.sh` (default `/opt/emsdk`), builds in `$CF_BUILD_DIR` (default `~/crossfish-build`, keep it out of
the cloud-synced folder) and copies the result. Flags: `em++ -O3 -std=c++17 -msimd128 -mavx2 -ffp-contract=off
-sSTANDALONE_WASM --no-entry`, memory growth on, 40 MiB initial memory, 2 MiB stack. `-mavx2` makes Emscripten's
headers emulate the `_mm256_*` intrinsics with wasm SIMD; no upstream intrinsic needed a replacement. Do not add
`-ffast-math` or allow FMA contraction: the macro net's table bake must stay bit-exact.
`--test` also exports `cf_test_fixed_depth(d)` / `cf_test_fresh_engine()` into `crossfish-test.wasm` (never copied to
the site), for the fixed-depth parity check below.

## Host requirements (WASI reactor, no JS glue)

1. Instantiate with `wasi_snapshot_preview1` and `env.emscripten_notify_memory_growth` (no-op). The module as built
   imports only `wasi_snapshot_preview1.clock_time_get` (real nanoseconds: the search's clock) and
   `env.emscripten_notify_memory_growth`; providing the usual `fd_write`, `random_get`, `environ_*`, `proc_exit`
   stubs as well is harmless.
2. Call the export `_initialize()` once.
3. Call `cf_new()` once at load time (inside the worker, before the first move is asked for). It decodes the net,
   bakes the macro table and builds the lookup tables: about 0.9 to 1.3 s under Node, once. Later `cf_new()` calls
   take under 1 ms.
4. Memory is the exported `memory` (40 MiB initially, never grew in the tests); re-read `memory.buffer` after calls
   if you read it.

## API

All `extern "C"`, one game at a time. Small boards are numbered 0 to 8 left to right, top to bottom, and so are the
cells inside each (this is upstream's own numbering, no conversion). Player 0 (X) moves first.

| export | meaning |
|---|---|
| `void cf_new()` | new game, fresh engine state (empty transposition table and history), like a new CodinGame game |
| `int cf_play(board, cell)` | play a move for the side to move: 1 if legal and played, 0 otherwise (nothing changes) |
| `int cf_think(ms)` | engine move for the side to move as `board*9+cell`, -1 if the game is over; does not play it. Iterative deepening, `ms` < 1 means 20. The engine persists between calls, as in CodinGame. The first move of a game is the fixed 4,4 (as CodinGame's bot), after searching `ms` to warm its tables. Budget about 12 ms below your real deadline: a search overshoots by up to about 10 ms |
| `int cf_legal(board)` | bit mask (bit c = cell c) of the cells of that small board the side to move may play; 0 if none or game over |
| `int cf_cell(board, cell)` | 0 empty, 1 player 0, 2 player 1 |
| `int cf_board_state(board)` | 0 open, 1 won by player 0, 2 won by player 1, 3 full without a winner |
| `int cf_winner()` | -1 in progress, 0 player 0, 1 player 1, 2 draw |
| `int cf_to_move()` | 0 or 1 |
| `int cf_last_depth()`, `cf_last_nodes()` (saturates at INT_MAX), `cf_last_score()` | about the last `cf_think` (score: engine's internal units, side-to-move relative) |

## Shim: `cf_stdlib_shim.hpp`

`std::uniform_int_distribution` is implementation-defined. Upstream's `GlobalBoard` constructor draws its Zobrist
keys with it, and libc++ (Emscripten) gives numbers off by one to a few from libstdc++ (g++). That changes
transposition-table collisions, so beyond depth ~10 node counts and sometimes the chosen move drifted from the
native engine. The shim reproduces libstdc++'s algorithm (checked on 2,000 draws) and maps the name onto it, so the
wasm engine is identical to the native/CodinGame one.

## Moving to a newer upstream commit

1. Check out the new commit, run `./build.sh <checkout> --any-commit`. If a new intrinsic is not emulated or a
   libc++/libstdc++ difference appears, fix it in a shim header here, never in upstream.
2. Prove parity with the repo's own fingerprint: build `cpp_impl/cg_selfcheck.cpp` natively (the Makefile flags) and
   for node (`em++ <same flags as build.sh> -I<checkout>/cpp_impl -I. -include cf_stdlib_shim.hpp cg_selfcheck.cpp
   -o x.js -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=50331648 -sSTACK_SIZE=2097152 -sENVIRONMENT=node`); `120 5`, `120 7`,
   `120 9`, `120 11` must print identical `nodes=` and `checksum=` lines. Also play a few hundred random games
   through `cf_legal`/`cf_play` against upstream's `GlobalBoard`.
3. Update `PINNED` in `build.sh` and the commit in this file.
