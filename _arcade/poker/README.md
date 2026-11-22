# poker

The site owner's CodinGame Poker bot ("cgpoker", sit-and-go for 2 to 4 players, 4,800 chips in total,
blinds 5/10 doubling every 10 hands) as WebAssembly, so a visitor can play no-limit hold'em against it in
the browser. One module holds both the game (upstream's C++ port of the referee) and the bot.

Upstream is not copied here: <https://github.com/nathanWolo/cgpoker>, pinned in `build.sh` (`PINNED=3d8f74c`).
`wasm_api.cpp` includes `engine/poker_engine.hpp` and `bot/bot.hpp` from a checkout that `build.sh` is given.
It is built from `bot/bot.hpp`, the readable source, not from the minified `submissions/*.cpp`.

The human is player 0 ("You"); every other seat (1 to 3, "Bot A" to "Bot C") is its own `bot::Bot`, kept for
the whole game, so each bot's tracker and its opponent model learn from the hands it has seen. One game at a time.

## Rebuild

Inside WSL / Linux, with Emscripten (`/opt/emsdk`, or `EMSDK=...`) and a cgpoker checkout:

```bash
cd _arcade/poker
./build.sh /path/to/cgpoker          # or CGPOKER_DIR=/path/to/cgpoker ./build.sh
# ALLOW_ANY_COMMIT=1 builds a checkout that is not the pinned commit
# OUT_DIR=/some/dir keeps the intermediate output out of the synced website folder
```

It runs `em++ -O2 -std=c++20 -fwasm-exceptions -sSTANDALONE_WASM --no-entry`, memory growth on, no
pthreads, no JavaScript glue, and copies the result to `../../assets/wasm/poker.wasm`.

## Host requirements (standalone reactor)

1. Instantiate with these imports and nothing else (the module imports exactly these five):
   `wasi_snapshot_preview1.clock_time_get` (real nanoseconds: the bot's time budget uses it),
   `wasi_snapshot_preview1.fd_close`, `wasi_snapshot_preview1.environ_get`,
   `wasi_snapshot_preview1.environ_sizes_get`, and `env.emscripten_notify_memory_growth` (a no-op).
   It is harmless to also provide `fd_write`, `fd_seek`, `random_get`, `proc_exit` as stubs.
2. Call the export `_initialize()` once before anything else.
3. Memory is the exported `memory`; re-read `memory.buffer` after every call (it can grow). The module asks for
   32 MiB up front; it did not grow further in the tests.
4. Build the evaluator tables once with `pk_init()` (about 100 ms under Node) or let the first `pk_new_game` do it.

Exports: `memory`, `_initialize`, `__indirect_function_table`, `__trap`, and the functions below.

## API

All `extern "C"`, integers are i32 (`unsigned` where noted).

| export | meaning |
|---|---|
| `pk_init() -> i32` | optional: build the evaluator tables now. 0 = ok |
| `pk_new_game(players, seed_lo: u32, seed_hi: u32) -> i32` | players 2..4. The 64-bit seed (hi:lo, signed) fixes the shuffle, who is big blind first and the deal. 0 = ok, 1 = error (see `pk_error_*`) |
| `pk_step() -> i32` | advance by ONE visible thing: one bot's action, or the dealing of a street (an all-in run-out deals all remaining streets at once), or the end of a hand. Returns **0** more to do (call again, after a pause so the visitor can follow), **1** waiting for the human (`options` is set), **2** the hand is over (`result` is set; call `pk_next_hand`), **3** the game is over. While 1, 2 or 3 it just returns the same value. -1 = internal error (`pk_error_*`) |
| `pk_act(kind, amount) -> i32` | the human's action: 0 fold, 1 check, 2 call, 3 all-in, 4 raise (or bet) TO `amount`, the total the human will have put in this betting round, as the original page's "RAISE to" (internally `BET amount - rnd`, the referee's own form). Accepted: 0. Not legal now: -1 and nothing changes. A raise needs `raise_min_to <= amount <= raise_max_to`, or exactly `allin_to` (which is an all-in). After an accepted action call `pk_step` |
| `pk_next_hand() -> i32` | after status 2: deal the next hand. 0 on success, -1 if the hand is not over |
| `pk_state_ptr() -> *const u8`, `pk_state_len() -> i32` | UTF-8 JSON of the current state, refreshed by every call above |
| `pk_set_budget(ms, trials)` | the bot's thinking budget from the next decision on. `ms > 0`: Monte Carlo until `ms` of wall clock (from the start of the decision) but at least `trials` trials; `ms <= 0`: exactly `trials` trials (rounded up to the bot's batch of 256/512), which makes the bot, and so the whole game, deterministic. Default: `ms = 15`, `trials = 2000` (what `bot/main.cpp` uses: 15 ms, `Budget`'s 2000 minimum). `trials <= 0` leaves the trial limit alone. Applies to the current game too |
| `pk_error_ptr() -> *const u8`, `pk_error_len() -> i32` | the last error message. C++ exceptions never leave the module: they become an error return, and the game they hit is then dead (every later call returns -1 until `pk_new_game`) |

A page typically runs in a worker: `pk_new_game`, then loop: `s = pk_step()`; render the JSON; `s == 0`: wait ~600 ms
and repeat; `s == 1`: wait for the visitor, `pk_act`, then `pk_step`; `s == 2`: show the result, wait for "next hand",
`pk_next_hand`; `s == 3`: done. Once the human is out (`players[0].out`) the bots play on: call `pk_next_hand`
immediately at each 2 if you want that fast (the original server does the same: "fast" mode).

## State JSON

The schema of `play/server.py`'s `/api/state` (what `play/index.html` renders), produced by a port of
`Game.state`, `finish_hand` and `narrate`. Keys (all always present):

| key | meaning |
|---|---|
| `status` | `running`, `hand_over`, `game_over` (`none` only before a game exists) |
| `hand`, `level`, `sb`, `bb`, `pot`, `rounds`, `n` | hand number, blind level, blinds, chips in the pot (all chips put in this hand), decisions so far, players |
| `board` | cards dealt so far, e.g. `["AS","7D","TC"]` (rank 23456789TJQKA, suit CDHS) |
| `players[]` | `id`, `name` ("You", "Bot A".."Bot C"), `human`, `stack`, `bet` (this betting round), `total` (this hand), `folded`, `allin`, `out`, `dealer`, `sb`, `bbpos`, `cards`, `acting`, `last` (last action this hand in words), `score` |
| `cards` | the human's two cards; a bot's `["??","??"]` until the hand is over, then its real cards; `[]` for a player who is out |
| `acting` | id of the player the game waits for, else -1 (bots act inside `pk_step`, so only 0 or -1 is visible) |
| `options` | when the human is up: `fold`, `check` (bool), `call` (chips to call, 0 = not offered), `allin` (chips, 0 = not offered), `allin_to`, `raise_min_to`, `raise_max_to` (0 = no raise possible; max is one chip short of all-in, all-in is `allin_to`), `rnd` (chips already in this round), `pot`, `bb`; else `null` |
| `events[]` | `{hand, kind, text}` hand log lines (`kind`: hand, action, street, result). Only the current and previous hand are kept (at most 150 lines) |
| `result` | after a hand: `{hand, board, showdown, players[]}`; each player `{pid, cards, net, folded, best}` (`best` is the best hand in words, `"a flush"`, for players who reached showdown) or `{pid, out: true}`. `null` while a hand is running |
| `thoughts[]`, `thoughts_hand` | what the bots were thinking at their decisions of the last finished hand (the one before this one while a hand is running): `{round, hand, pid, name, board, action, tag, eq, note}`. `eq` is the bot's equity estimate (-1 = decided by a chart), `tag` the rule that fired, `note` the opponent model's read |
| `seed`, `seed_lo`, `seed_hi` | the 64-bit seed as one integer (a JS number cannot hold all of it: use the two halves) and as the two words given to `pk_new_game` |
| `delay`, `auto_next` | always `0.0` / `false` (server.py's page settings; unused here) |

Differences from `/api/state` (checked by running the Python server's own `Game` code against this module):
`seed_lo`/`seed_hi` are added; `events` hold only two hands and `thoughts` only the last one (the server keeps all);
`delay` is fixed; `thoughts` come from `bot::Bot::last_tag / last_equity / last_note` instead of the bot process's
stderr line; and `pk_step` returns status 2 even after the human is out (the server skips that pause).
Like the server, an all-in run-out that starts before the flop logs one `River: <card>` line (not three streets).

## How the turn is split

`Engine::game_turn` calls `agents[pid]->act()` synchronously. `SplitEngine::pre` is that function up to the agent
call (it returns the seat and its `Obs` when someone has to act) and `SplitEngine::post` is the rest (parse, replace
illegal actions, apply, log). Both are copied next to upstream's code, not edited into it. A bot's answer comes from
`bot::Bot::act(obs, budget, now)` exactly as `arena/arena.cpp` drives it, with `use_fast = true` after `pe::init()`
(`main.cpp` sets that when its background thread finishes; here the tables are built synchronously, no threads).

## Moving to a newer upstream commit

1. Check out the new commit and run `ALLOW_ANY_COMMIT=1 ./build.sh /path/to/cgpoker`. If the build fails, the usual
   suspects are `Engine`/`Board` members used in `SplitEngine` (`game_turn` is the model: re-copy its body into `pre`
   and `post` if it changed), `bot::Bot::act` / `Budget`, and the `Obs` fields.
2. Compare the split with upstream: play whole games with bots in every seat through `Engine::run` and through
   `Session::step` (build a small native harness that `#define PK_NO_EXPORTS` and `#include "wasm_api.cpp"`),
   trials-only budget (`ms = 0`), and check the action logs, stacks after every hand and final ranking are identical.
3. Re-check the JSON against `play/server.py` (`Game.state` / `finish_hand` / `narrate`) if that file changed.
4. Change `PINNED` in `build.sh` to the new commit, rebuild, commit the new `assets/wasm/poker.wasm`.

## Notes

- Determinism: with `pk_set_budget(0, N)` the same seed and the same human actions give the same game, byte for byte
  (also between the wasm build and a native build, if both use libc++: the bot's `top_range` uses `std::sort` on tied
  keys, so a libstdc++ build, whose `std::sort` orders ties differently, plays slightly different Monte Carlo ranges).
- The game, bots included, stays in memory until the next `pk_new_game`; the JSON is rebuilt after every call.
- The 600-decision cap (the referee cancels the unfinished hand and ends the game) is ported but a game never got
  near it in the tests.
