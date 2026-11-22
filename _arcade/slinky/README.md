# slinky_arcade

The site owner's Battlesnake agent, "AlphaSlinky" (an AlphaZero-style network plus a PUCT search),
as WebAssembly, so a visitor can play Battlesnake against it in the browser.

The engine is upstream, unmodified: <https://github.com/nathanWolo/slinky> (`native/` workspace:
`slinky-rules`, `-env`, `-api`, `-net`, `-obs`, `-search`), pinned by commit in `Cargo.toml`.
This crate only adds a one-game-at-a-time facade and a C ABI. Target is `wasm32-wasip1` (not
`wasm32-unknown-unknown`) because the search calls `std::time::Instant::now()`, which panics on
unknown-unknown and works under WASI (`clock_time_get`).

## Rebuild

```bash
cd _arcade/slinky
export CARGO_TARGET_DIR=/some/dir/outside/the/synced/site   # keep build output out of OneDrive
./build.sh        # -> ../../assets/wasm/slinky.wasm
cargo test --release   # native tests, with the weights in assets/wasm/slinky-weights/ (skips if absent)
```

Needs `rustup target add wasm32-wasip1`. `build.sh` uses `-C target-feature=+simd128` and makes sure
wasi-libc's `crt1-reactor.o` (from the target's `self-contained/` dir) is linked in. Without that
object a cdylib exports no `_initialize` at all. Rust 1.97 leaves it out unless it is named;
Rust 1.100 links it by itself, and `build.sh` copes with both.

The page loads `assets/wasm/slinky.wasm`, `assets/wasm/slinky-weights/config.json` and
`params.npz` (the weights are passed in as bytes; nothing reads a file).

## Host requirements (WASI reactor)

1. Instantiate with the `wasi_snapshot_preview1` imports the module declares:
   `random_get`, `environ_get`, `environ_sizes_get`, `clock_time_get`, `fd_write`, `proc_exit`.
   (Stubs are enough, but `clock_time_get` must return real nanoseconds: the time budget uses it,
   and `random_get` should fill bytes: Rust's HashMap seeds from it.)
2. Call the export `_initialize()` once before anything else.
3. Memory is the exported `memory`; re-read `memory.buffer` after each call (it can grow).

## Exported API

All `extern "C"`, one game at a time. Integers are i32 (`u32` where noted).

| export | meaning |
|---|---|
| `bs_alloc(len: u32) -> *mut u8`, `bs_free(ptr, len)` | buffers the page can write into / release |
| `bs_init(config_ptr, config_len, npz_ptr, npz_len) -> i32` | load the network from `config.json` and `params.npz` bytes. 0 = ok, else message at `bs_error_ptr()/bs_error_len()` (UTF-8) |
| `bs_new_game(mode, snakes, seed_lo: u32, seed_hi: u32) -> i32` | mode 0 standard (3 to 4 snakes), 1 duel (2), 2 royale (2 to 4), 3 constrictor (2 to 4, empty map: no food); 11x11, the ladder configuration of `slinky-env`. Seed fixes start positions and food. 0 = ok |
| `bs_state_ptr() -> *const u8`, `bs_state_len() -> u32` | JSON snapshot, refreshed by `bs_new_game` and `bs_step` |
| `bs_think(snake, sims, budget_ms) -> i32` | move for that snake: 0 up (y+1), 1 down, 2 left, 3 right (upstream's own action ids). `sims > 0`: exactly that many simulations, deterministic for a seed. Else search until `budget_ms` (200 if not positive), at most 16,384 simulations. -1 if the snake is dead, the game is over, or on error. Does not change the game; any snake, any order, any number of times |
| `bs_step(m0, m1, m2, m3) -> i32` | one simultaneous turn (ignored for dead snakes and indices >= snake count; a value outside 0..3 repeats that snake's last move). 1 = game over now, 0 = not, -1 = error (e.g. already over) |
| `bs_last_sims() -> i32`, `bs_last_value() -> i32` | simulations run by the last `bs_think`; its root value for that snake times 1000 (about -1000 loss to 1000 win) |
| `bs_error_ptr()`, `bs_error_len()` | last error message |

State JSON (API coordinates, x right, y up, origin bottom-left):

```json
{"turn":0,"width":11,"height":11,"mode":"duel","food":[[x,y]],"hazards":[[x,y]],"hazard_damage":0,
 "snakes":[{"alive":true,"health":100,"length":3,"body":[[x,y],...]}],"over":false,"winner":-1}
```

Body is head first; an eliminated snake has `alive:false`, health 0, empty body. `winner` is the
last snake alive once over, else -1. `hazard_damage` is 0 outside royale.

## How the agent is configured

Copied from the deployed `/az-t200` (`deploy/lambda-native/deploy.sh`, `crates/lambda/src/engine.rs`):
one search tree (`threads` 1), `RESCALE_Q=standard`, tree reuse on, per-tree memory cap 256 MiB,
simulation cap 16,384, tie noise `tie_seed(game id, turn)` (the lambda's FNV-1a). Every move is
searched from a Battlesnake `/move` request built from the game state (`to_request_json`) and read
back through `game_from_request` with `starting_snakes` = the game's snake count, as the server
does. Each snake owns a search workspace for the whole game, so its tree is reused turn to turn.
Not copied: the 150 ms deadline margin and the request timeout (the page's `budget_ms` is the
deadline), and the early stop, which is off in both modes here (the deployed `/az-t200` has it off
with reuse; the deployed `/az-256` has it on, which never changes the move but may run fewer than
256 simulations; here `sims` means exactly `sims`).

## Moving to a newer engine or newer weights

- Engine: in `Cargo.toml` change `rev` on the five `slinky-*` lines to the new commit (or a
  `branch`/`tag`), `cargo update -p slinky-search`, run `cargo test --release` (it compares
  `bs_think` with upstream's `Agent` directly, so an API or behaviour change shows up), then
  `./build.sh`. If upstream changes settings in `crates/lambda/src/engine.rs` or `deploy.sh`,
  mirror them in `Arcade::new` / `Arcade::think` (`src/lib.rs`).
- Weights: replace `assets/wasm/slinky-weights/config.json` and `params.npz` with the new run's
  files (the network must be a `slinky-net` format; no rebuild needed). Update the path in
  `tests/arcade.rs` if you test against the new ones.
- `bs_smoke.py`-style check: play a game under wasmtime and compare its move list with
  `cargo run --release --example play -- <weights dir> <mode> <snakes> <seed> <sims>`.
  Under Node, `node ../check_wasm.mjs slinky-moves <mode> <snakes> <seed> <sims>` prints the built
  file's game in the same form, so `diff` compares the two. (On Windows a whole 542-turn game was
  identical. `exp` and `tanh` come from the C library, and glibc, mingw and wasi-libc round `tanh`
  differently in the last bit, so deep into a game a difference need not mean a fault; `update.sh`
  requires the first 30 turns to be the same.)
- The arcade-engines workflow does the engine steps with `../update.sh rebuild slinky <checkout>`
  (see `../README.md`). It cannot refresh the weights, and its pull request says when
  `engine.rs` or `deploy.sh` changed upstream.
