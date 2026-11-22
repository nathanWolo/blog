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
