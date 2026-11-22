# tronzero_arcade

The AlphaZero-style Tron agent from [nathanWolo/tron-codingame](https://github.com/nathanWolo/tron-codingame)
("tronzero": a small convolutional policy/value network with PUCT search, 30 x 20 board, 2 to 4 bikes
moving in turn), built as WebAssembly so a visitor can play against it in the browser. The folder name
starts with an underscore so Jekyll leaves it out of the site.

- `src/upstream/{board,net,mcts,play}.rs` and `net_packed.txt` are generated; do not edit them.
- `src/api.rs` holds the game and the exported functions (same names as the masthead engine in `_engine/`).
- `src/lib.rs` includes the modules at the crate root (the upstream code refers to `crate::board` etc.).

## Re-derive and rebuild

    python derive.py /path/to/tron-codingame      # rewrites src/upstream/* and net_packed.txt
    CARGO_TARGET_DIR=/somewhere/outside/the/site ./build.sh   # writes ../../assets/wasm/tronzero.wasm
    cargo test --release                          # native tests (full 2p and 4p games, eliminate)

`derive.py` applies exact-text substitutions and asserts each matched as often as expected, so it
fails if upstream changes shape. The substitutions gate the AVX2/FMA kernels and CPU detection behind
`cfg(target_arch = "x86_64")` (the scalar path is used elsewhere, e.g. WebAssembly) and drop the
CodinGame stdin loop from `play.rs`. On x86_64 the code behaves exactly like upstream.

`build.sh` targets `wasm32-wasip1` with `+simd128` and links Rust's `crt1-reactor.o`, which is what
makes the module export `_initialize`. The page must call `_initialize` once, before anything else, and
supply the `wasi_snapshot_preview1` imports: `environ_get`, `environ_sizes_get`, `clock_time_get`,
`fd_write`, `proc_exit`.

## Exported API

Directions: 0 up, 1 down, 2 left, 3 right (y grows downward). Players are 0-based, in turn order.
Booleans are 1/0. One game at a time.

| function | meaning |
| --- | --- |
| `tron_new_game(width, height, players)` | 1 only for 30 x 20 and 2..=4 players |
| `tron_set_wall(col, row)` | always 0 (walls unsupported) |
| `tron_spawn(player, col, row)` | place a bike before the first move; the game starts when the last is placed |
| `tron_think(player, budget_ms)` | engine's move within the budget, -1 if not that player's turn / dead / no legal move; does not play it |
| `tron_think_sims(player, sims)` | same with a fixed simulation count (deterministic) |
| `tron_play(player, dir)` | play for the player to move; 0 and no change if illegal or out of turn |
| `tron_eliminate(player)` | remove a living player who crashed; its trail leaves the board; the turn passes if it was theirs |
| `tron_to_move()` | player to move, -1 when over or not set up |
| `tron_alive(player)`, `tron_over()`, `tron_winner()` | state (winner -1 until decided) |
| `tron_last_sims()`, `tron_last_score()` | simulations of the last think; its root value times 1000 for the mover (0 for forced moves) |

The search tree is not kept between moves (upstream resets it per move).
