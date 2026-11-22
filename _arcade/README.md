# Arcade engines

The game engines behind `/arcade/`, as WebAssembly. Jekyll does not publish this folder (its name
starts with an underscore); what the site serves are the built files in `assets/wasm/`, which are
committed, so GitHub Pages needs no build step.

| Game | Engine | Source here | Built file |
|---|---|---|---|
| Tron | alpha-beta, from [tron-codingame](https://github.com/nathanWolo/tron-codingame) `legacy/alpha-beta` | `../_engine/` (also plays the home page masthead) | `assets/wasm/tron.wasm` |
| Tron | tronzero, from tron-codingame `engine/` | `tronzero/`: upstream's four source files, derived by `derive.py`, plus a small API | `assets/wasm/tronzero.wasm` |
| Battlesnake | AlphaSlinky, from [slinky](https://github.com/nathanWolo/slinky) `native/` | `slinky/`: a wrapper over the upstream crates, which cargo fetches at a pinned commit | `assets/wasm/slinky.wasm`, weights in `assets/wasm/slinky-weights/` |
| Ultimate Tic-Tac-Toe | crossfish, from [crossfish](https://github.com/nathanWolo/crossfish) `cpp_impl/codingame_nnue.cpp` | `crossfish/`: a small API that includes the upstream file from a checkout | `assets/wasm/crossfish.wasm` |
| Poker | the bot and the referee port from [cgpoker](https://github.com/nathanWolo/cgpoker) `bot/`, `engine/` | `poker/`: a small API that includes the upstream headers from a checkout | `assets/wasm/poker.wasm` |

Each folder has its own README with the exported functions, how it was checked against the
original, and how to rebuild. In short:

```bash
# The two Rust engines (any OS with rustup)
rustup target add wasm32-wasip1        # once
export CARGO_TARGET_DIR=/somewhere/outside/this/synced/folder
_arcade/tronzero/build.sh
_arcade/slinky/build.sh

# The two C++ engines (Linux or WSL with Emscripten; EMSDK defaults to /opt/emsdk)
_arcade/crossfish/build.sh /path/to/crossfish-checkout
_arcade/poker/build.sh /path/to/cgpoker-checkout
```

The pages are `arcade/*.html`; their scripts are in `assets/js/arcade/`. `engine-loader.js` loads
any of the modules in a worker and supplies the few WASI functions they import (the Rust ones are
built for `wasm32-wasip1`, the C++ ones as Emscripten standalone modules).

To move to a newer engine:

- **tronzero**: run `derive.py` against a newer checkout (it stops if upstream no longer has the
  lines it changes) and rebuild.
- **AlphaSlinky**: change `rev` in `slinky/Cargo.toml` and rebuild, and replace the two files in
  `assets/wasm/slinky-weights/` if the weights changed.
- **crossfish** and **poker**: each `build.sh` refuses a checkout that is not at the commit it was
  checked against unless told otherwise (see its header). Build the newer checkout, then repeat the
  comparison with the native build described in that folder's README before committing the result.

For the Rust engines, run `cargo test --release` in the crate before rebuilding: the tests compare
the wrapper with upstream.

## Following the engine repositories

`.github/workflows/arcade-engines.yml` does the above by itself. Every Monday, and when started by
hand from the repository's Actions tab, it compares each engine's repository with the commit the
Arcade is built from. Where the sources the build reads have moved, it rebuilds the engine, runs
the checks below and, only if all of them pass, opens a pull request from the branch
`arcade/<engine>` with the new build and the new pin. Nothing reaches the site until that pull
request is merged, so the new build can be tried first (check the branch out and play a game: no
check here opens a browser). If a check fails, the job fails and says at which step; no branch or
pull request is touched.

It needs one setting, once: Settings > Actions > General > Workflow permissions > "Allow GitHub
Actions to create and approve pull requests".

| Engine | The pin | What must pass |
|---|---|---|
| tronzero | the commit in the header of `tronzero/src/upstream/*.rs` | `derive.py` finds every line it changes; `C_PUCT` and `FPU_REDUCTION` in `src/lib.rs` equal upstream's `main.rs`; `cargo test --release`; `check_wasm.mjs tronzero` |
| AlphaSlinky | `rev` in `slinky/Cargo.toml` (and `Cargo.lock`) | `cargo test --release` (it compares `bs_think` with upstream's `Agent`); the built file plays the first 30 turns of a game move for move as the native build does; `check_wasm.mjs slinky` |
| crossfish | `PINNED` in `crossfish/build.sh` | `crossfish/check.sh`: upstream's `cg_selfcheck` fingerprint is the same from the native and the WebAssembly build; `check_wasm.mjs crossfish` |
| poker | `PINNED` in `poker/build.sh` | `poker/check.sh`: whole games through upstream's `Engine::run` and through the Arcade's split game loop are identical (`check_split.cpp`); `check_wasm.mjs poker` |

`check_wasm.mjs` plays the built files under Node, loaded by the page's own `engine-loader.js`, and
checks every position on the way (for poker: the chips, and that exactly the offered actions are
accepted). `update.sh` holds the steps and works by hand as well:

```bash
_arcade/update.sh pinned crossfish                    # the commit the Arcade is built from
_arcade/update.sh changed crossfish /path/to/checkout # "changed" if what the build reads differs
_arcade/update.sh rebuild crossfish /path/to/checkout # build, check, move the pin
```

Details worth knowing:

- The workflow has two jobs. `build` compiles and runs code from the engine repositories and their
  dependencies, so it may only read this repository and is given no token; it hands its result
  over as a patch. `propose` may push a branch and open a pull request, runs none of that code, and
  takes the patch through `update.sh apply`, which refuses one that changes anything outside
  `_arcade/<engine>/` and `assets/wasm/<engine>.wasm`.
- An engine counts as moved only if the paths its build reads differ from the pinned commit
  (`READS` in `update.sh`); a commit that touches only other parts of a repository is passed over
  and the pin stays where it is. Starting the workflow by hand with "force" rebuilds regardless.
- The branch `arcade/<engine>` belongs to the workflow, which overwrites it. While it holds a build
  of upstream's current commit the workflow leaves it alone, whether its pull request is open or
  was closed; delete the branch to have that commit proposed again.
- The pull request says what to look at by hand: settings this folder repeats from files upstream
  that no check reads (`main.rs` for tronzero, the Lambda's `engine.rs` and `deploy.sh` for
  AlphaSlinky, `play/server.py` for poker).
- Not covered: the alpha-beta Tron engine (`../_engine/`, a hand port) and the AlphaSlinky weights
  (`assets/wasm/slinky-weights/`), which are not in the slinky repository.
- The C++ engines are built with the Emscripten version named at the top of the workflow file.
