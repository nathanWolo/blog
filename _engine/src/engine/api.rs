//! Board setup and the functions the page calls.
//!
//! One game is held at a time. The page creates it with a grid size, marks the
//! cells under the name plate as walls, places the two bikes, then alternates
//! `think` (ask the engine for a move) and `play` (make it).
//!
//! Directions are the engine's own: 0 up, 1 down, 2 left, 3 right.

use super::*;
use std::sync::{Mutex, MutexGuard};

struct Game {
    state: State,
    scratch: Scratch,
    /// The last direction each bike moved, which the engine uses to order moves.
    last_dir: [u8; MAX_PLAYERS],
    width: i32,
    height: i32,
}

static GAME: Mutex<Option<Box<Game>>> = Mutex::new(None);

fn game() -> MutexGuard<'static, Option<Box<Game>>> {
    match GAME.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// Start a game on a `width` x `height` grid (at most 64 x 20) for `players`
/// bikes. Every storage cell outside the grid starts as a wall.
pub(super) fn new_game(width: i32, height: i32, players: i32) -> bool {
    if !(2..=WIDTH).contains(&width)
        || !(2..=HEIGHT).contains(&height)
        || !(2..=MAX_PLAYERS as i32).contains(&players)
    {
        return false;
    }
    let mut state = State::new(players as u8);
    for row in 0..HEIGHT {
        for col in 0..WIDTH {
            if col >= width || row >= height {
                state.occupied.set(col, row);
            }
        }
    }
    CENTER_COL.store((width - 1) / 2, Ordering::Relaxed);
    CENTER_ROW.store((height - 1) / 2, Ordering::Relaxed);
    WALL_CELLS.store(WIDTH * HEIGHT - width * height, Ordering::Relaxed);
    *game() = Some(Box::new(Game {
        state,
        scratch: Scratch::new(),
        last_dir: [NO_MOVE; MAX_PLAYERS],
        width,
        height,
    }));
    true
}

/// Turn the empty cell `(col, row)` into a wall.
pub(super) fn set_wall(col: i32, row: i32) -> bool {
    let mut guard = game();
    let Some(game) = guard.as_mut() else {
        return false;
    };
    if col < 0 || col >= game.width || row < 0 || row >= game.height {
        return false;
    }
    if game.state.occupied.is_set(col, row) {
        return false;
    }
    game.state.occupied.set(col, row);
    WALL_CELLS.fetch_add(1, Ordering::Relaxed);
    true
}

/// Put `player`'s bike on the empty cell `(col, row)`.
pub(super) fn spawn(player: i32, col: i32, row: i32) -> bool {
    let mut guard = game();
    let Some(game) = guard.as_mut() else {
        return false;
    };
    if player < 0 || player >= game.state.player_count as i32 {
        return false;
    }
    if col < 0 || col >= game.width || row < 0 || row >= game.height {
        return false;
    }
    if game.state.is_alive(player as usize) || game.state.occupied.is_set(col, row) {
        return false;
    }
    game.state.occupy(player as usize, col, row);
    true
}

/// The direction the engine picks for `player` within `budget_ms`, or -1 when
/// the bike has no free neighbour. Does not move the bike.
pub(super) fn think(player: i32, budget_ms: i32) -> i32 {
    let mut guard = game();
    let Some(game) = guard.as_mut() else {
        return -1;
    };
    if player < 0 || player >= game.state.player_count as i32 {
        return -1;
    }
    let player = player as usize;
    if !game.state.is_alive(player) || game.state.legal_moves(player).1 == 0 {
        return -1;
    }
    let dir = choose_move(
        &mut game.state,
        player,
        game.last_dir[player],
        budget_ms.max(1) as u64,
        &mut game.scratch,
    );
    dir as i32
}

/// Move `player` one cell in `dir`. False, and nothing changes, if that cell
/// is blocked.
pub(super) fn play(player: i32, dir: i32) -> bool {
    let mut guard = game();
    let Some(game) = guard.as_mut() else {
        return false;
    };
    if player < 0 || player >= game.state.player_count as i32 || !(0..4).contains(&dir) {
        return false;
    }
    let player = player as usize;
    if !game.state.is_alive(player) || !game.state.apply(player, dir as usize) {
        return false;
    }
    game.last_dir[player] = dir as u8;
    true
}

// The WebAssembly exports. Booleans are returned as 1 or 0.

#[no_mangle]
pub extern "C" fn tron_new_game(width: i32, height: i32, players: i32) -> i32 {
    new_game(width, height, players) as i32
}

#[no_mangle]
pub extern "C" fn tron_set_wall(col: i32, row: i32) -> i32 {
    set_wall(col, row) as i32
}

#[no_mangle]
pub extern "C" fn tron_spawn(player: i32, col: i32, row: i32) -> i32 {
    spawn(player, col, row) as i32
}

#[no_mangle]
pub extern "C" fn tron_think(player: i32, budget_ms: i32) -> i32 {
    think(player, budget_ms)
}

#[no_mangle]
pub extern "C" fn tron_play(player: i32, dir: i32) -> i32 {
    play(player, dir) as i32
}

/// Depth the last `tron_think` search completed (0 when it did not search).
#[no_mangle]
pub extern "C" fn tron_last_depth() -> i32 {
    LAST_DEPTH.load(Ordering::Relaxed)
}

/// Nodes the last `tron_think` search visited.
#[no_mangle]
pub extern "C" fn tron_last_nodes() -> i32 {
    LAST_NODES.load(Ordering::Relaxed)
}

/// Score of the last `tron_think` search, from the mover's point of view.
#[no_mangle]
pub extern "C" fn tron_last_score() -> i32 {
    LAST_SCORE.load(Ordering::Relaxed)
}
