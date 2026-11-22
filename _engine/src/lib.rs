//! The Tron engine that plays the game in the blog's masthead.
//!
//! `engine.rs` is the alpha-beta bot from nathanWolo/tron-codingame with a few
//! adaptations, listed at the top of that file. `engine/api.rs` sets up a board
//! with walls and exports the functions the page calls. `clock.rs` supplies the
//! time source.
//!
//! Build with `./build.sh`, which writes `assets/wasm/tron.wasm`. The folder
//! name starts with an underscore so that Jekyll leaves it out of the site.

mod clock;
mod engine;
