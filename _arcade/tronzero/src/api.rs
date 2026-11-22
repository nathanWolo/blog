//! Board setup and the functions the page calls.
//!
//! One game is held at a time. The page creates it with `tron_new_game`,
//! places every bike with `tron_spawn`, then alternates `tron_think` (ask the
//! engine for a move) and `tron_play` (make it, for the engine or the human).
//! A human who steers into a wall is taken out with `tron_eliminate`.
//!
//! Directions are the engine's own: 0 up, 1 down, 2 left, 3 right, with y
//! growing downward. Players are numbered from 0 in turn order. Booleans are
//! returned as 1 or 0.
//!
//! The search is started afresh on every move (the upstream `Search::reset`
//! clears the tree and keeps none between moves), so nothing has to be kept
//! in step with the moves played through `tron_play`.

use crate::board::{State, H, MAXP, W};
use crate::mcts::{Params, Search};
use crate::net::Net;
use crate::play::{timed_move, Limit};
use crate::{C_PUCT, FPU_REDUCTION, NET_PACKED};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

struct Game {
    players: usize,
    /// Where each bike was spawned. The upstream `State` is built from all of
    /// them at once, when the last one is placed.
    starts: [Option<(i32, i32)>; MAXP],
    state: Option<State>,
    search: Search,
    last_sims: i32,
    last_score: i32,
}

static NET: OnceLock<Net> = OnceLock::new();
static GAME: Mutex<Option<Box<Game>>> = Mutex::new(None);

/// The network, decoded on first use (it takes a moment).
fn net() -> &'static Net {
    NET.get_or_init(|| Net::from_packed(NET_PACKED))
}

fn game() -> MutexGuard<'static, Option<Box<Game>>> {
    match GAME.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

const PARAMS: Params = Params { c_puct: C_PUCT, fpu_reduction: FPU_REDUCTION };

/// Start a game: 30 x 20 and 2 to 4 players only.
pub fn new_game(width: i32, height: i32, players: i32) -> bool {
    if width != W || height != H || !(2..=MAXP as i32).contains(&players) {
        return false;
    }
    let net = net();
    *game() = Some(Box::new(Game {
        players: players as usize,
        starts: [None; MAXP],
        state: None,
        search: Search::new(net),
        last_sims: 0,
        last_score: 0,
    }));
    true
}

/// Walls are not supported.
pub fn set_wall(_col: i32, _row: i32) -> bool {
    false
}

/// Put `player`'s bike on the cell `(col, row)`, before the first move.
pub fn spawn(player: i32, col: i32, row: i32) -> bool {
    let mut guard = game();
    let Some(g) = guard.as_mut() else { return false };
    if g.state.is_some() || player < 0 || player as usize >= g.players {
        return false;
    }
    let p = player as usize;
    if col < 0 || col >= W || row < 0 || row >= H || g.starts[p].is_some() {
        return false;
    }
    if g.starts.iter().flatten().any(|&c| c == (col, row)) {
        return false;
    }
    g.starts[p] = Some((col, row));
    if g.starts[..g.players].iter().all(|s| s.is_some()) {
        let starts: Vec<(i32, i32)> = g.starts[..g.players].iter().map(|s| s.unwrap()).collect();
        g.state = Some(State::new(&starts));
    }
    true
}

/// How `think` asks for its time.
#[derive(Clone, Copy)]
enum Budget {
    Ms(i32),
    Sims(i32),
}

/// The engine's move for `player`, or -1. Does not play it.
fn think(player: i32, budget: Budget) -> i32 {
    let mut guard = game();
    let Some(g) = guard.as_mut() else { return -1 };
    g.last_sims = 0;
    g.last_score = 0;
    let Some(st) = g.state.as_ref() else { return -1 };
    if player < 0 || player as usize >= g.players {
        return -1;
    }
    let p = player as usize;
    if st.over() || !st.is_alive(p) || st.to_move as usize != p || st.legal_mask(p) == 0 {
        return -1;
    }
    let limit = match budget {
        Budget::Ms(ms) => Limit::Until(Instant::now() + Duration::from_millis(ms.max(1) as u64)),
        Budget::Sims(n) => Limit::Sims(n.max(0) as u32),
    };
    let (dir, sims, q) = timed_move(net(), &mut g.search, st, &PARAMS, limit);
    if dir > 3 || st.legal_mask(p) >> dir & 1 == 0 {
        return -1;
    }
    g.last_sims = sims as i32;
    g.last_score = (q * 1000.0) as i32;
    dir as i32
}

/// Play `dir` for the player to move.
pub fn play(player: i32, dir: i32) -> bool {
    let mut guard = game();
    let Some(g) = guard.as_mut() else { return false };
    let Some(st) = g.state.as_mut() else { return false };
    if player < 0 || player as usize >= g.players || !(0..4).contains(&dir) {
        return false;
    }
    let p = player as usize;
    if st.over() || st.to_move as usize != p || st.legal_mask(p) >> dir & 1 == 0 {
        return false;
    }
    st.play(dir as usize);
    true
}

/// Take a living player out of the game: it crashed. Its trail leaves the board.
pub fn eliminate(player: i32) -> bool {
    let mut guard = game();
    let Some(g) = guard.as_mut() else { return false };
    let Some(st) = g.state.as_mut() else { return false };
    if player < 0 || player as usize >= g.players || st.over() || !st.is_alive(player as usize) {
        return false;
    }
    let p = player as usize;
    if st.to_move as usize == p {
        // Upstream's own path for the mover that is out: the turn passes on.
        st.forfeit();
    } else {
        st.kill(p);
        st.settle();
    }
    true
}

fn with_state<T>(default: T, f: impl FnOnce(&Game, &State) -> T) -> T {
    let guard = game();
    match guard.as_ref() {
        Some(g) => match g.state.as_ref() {
            Some(st) => f(g, st),
            None => default,
        },
        None => default,
    }
}

// The WebAssembly exports.

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

/// The engine's move for `player` within `budget_ms`, or -1 if it is not that
/// player's turn, the player is out, or the game is over. Does not play it.
#[no_mangle]
pub extern "C" fn tron_think(player: i32, budget_ms: i32) -> i32 {
    think(player, Budget::Ms(budget_ms))
}

/// Like `tron_think`, with a fixed number of simulations (deterministic).
#[no_mangle]
pub extern "C" fn tron_think_sims(player: i32, sims: i32) -> i32 {
    think(player, Budget::Sims(sims))
}

#[no_mangle]
pub extern "C" fn tron_play(player: i32, dir: i32) -> i32 {
    play(player, dir) as i32
}

#[no_mangle]
pub extern "C" fn tron_eliminate(player: i32) -> i32 {
    eliminate(player) as i32
}

/// The player to move, or -1 when the game is over or not yet set up.
#[no_mangle]
pub extern "C" fn tron_to_move() -> i32 {
    with_state(-1, |_, st| if st.over() { -1 } else { st.to_move as i32 })
}

#[no_mangle]
pub extern "C" fn tron_alive(player: i32) -> i32 {
    with_state(0, |g, st| (player >= 0 && (player as usize) < g.players && st.is_alive(player as usize)) as i32)
}

#[no_mangle]
pub extern "C" fn tron_over() -> i32 {
    with_state(0, |_, st| st.over() as i32)
}

/// The winner once the game is over, else -1.
#[no_mangle]
pub extern "C" fn tron_winner() -> i32 {
    with_state(-1, |_, st| if st.over() && st.alive != 0 { st.alive.trailing_zeros() as i32 } else { -1 })
}

/// Simulations the last `tron_think` ran (0 when it did not search).
#[no_mangle]
pub extern "C" fn tron_last_sims() -> i32 {
    game().as_ref().map_or(0, |g| g.last_sims)
}

/// Root value of the last search times 1000, from the mover's view (0 when it did not search).
#[no_mangle]
pub extern "C" fn tron_last_score() -> i32 {
    game().as_ref().map_or(0, |g| g.last_score)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board::{DIR_X, DIR_Y};

    /// One game at a time lives in a static, so the tests take turns.
    static LOCK: Mutex<()> = Mutex::new(());

    fn lock() -> MutexGuard<'static, ()> {
        LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    const STARTS: [(i32, i32); 4] = [(5, 5), (24, 14), (24, 5), (5, 14)];

    fn setup(players: i32) {
        assert_eq!(tron_new_game(30, 20, players), 1);
        for p in 0..players {
            assert_eq!(tron_spawn(p, STARTS[p as usize].0, STARTS[p as usize].1), 1);
        }
        assert_eq!(tron_to_move(), 0);
    }

    fn head_free(trail: &[[bool; 30]; 20], pos: (i32, i32), d: i32) -> bool {
        let (x, y) = (pos.0 + DIR_X[d as usize], pos.1 + DIR_Y[d as usize]);
        x >= 0 && x < 30 && y >= 0 && y < 20 && !trail[y as usize][x as usize]
    }

    /// Play a whole game with the engine for every seat; returns the number of plies.
    fn full_game(players: i32, sims: i32) -> usize {
        setup(players);
        let mut pos: Vec<(i32, i32)> = STARTS[..players as usize].to_vec();
        // Every bike's trail; a bike that is out takes its trail off the board.
        let mut trails: Vec<Vec<(i32, i32)>> = pos.iter().map(|&c| vec![c]).collect();
        let mut plies = 0;
        while tron_over() == 0 {
            let mut occ = [[false; 30]; 20];
            for (q, t) in trails.iter().enumerate() {
                if tron_alive(q as i32) == 1 {
                    for &(x, y) in t {
                        occ[y as usize][x as usize] = true;
                    }
                }
            }
            let p = tron_to_move();
            assert!(p >= 0 && tron_alive(p) == 1);
            // Not their turn: no move.
            assert_eq!(tron_think_sims((p + 1) % players, 10), -1);
            assert_eq!(tron_play((p + 1) % players, 0), 0);
            let d = tron_think_sims(p, sims);
            assert!((0..4).contains(&d), "no move for player {p}");
            assert!(head_free(&occ, pos[p as usize], d), "illegal move {d} for player {p}");
            assert_eq!(tron_play(p, d), 1);
            let np = (pos[p as usize].0 + DIR_X[d as usize], pos[p as usize].1 + DIR_Y[d as usize]);
            pos[p as usize] = np;
            trails[p as usize].push(np);
            plies += 1;
            assert!(plies < 700);
        }
        assert_eq!(tron_to_move(), -1);
        let w = tron_winner();
        assert!(w >= 0 && w < players && tron_alive(w) == 1);
        let alive: i32 = (0..players).map(|q| tron_alive(q)).sum();
        assert_eq!(alive, 1);
        assert_eq!(tron_think_sims(w, 10), -1);
        plies
    }

    #[test]
    fn two_player_game_to_the_end() {
        let _g = lock();
        let plies = full_game(2, 200);
        println!("2 players: {plies} plies");
    }

    #[test]
    fn four_player_game_to_the_end() {
        let _g = lock();
        let plies = full_game(4, 100);
        println!("4 players: {plies} plies");
    }

    #[test]
    fn setup_rules() {
        let _g = lock();
        assert_eq!(tron_new_game(64, 20, 2), 0);
        assert_eq!(tron_new_game(30, 20, 1), 0);
        assert_eq!(tron_new_game(30, 20, 5), 0);
        assert_eq!(tron_new_game(30, 20, 3), 1);
        assert_eq!(tron_set_wall(3, 3), 0);
        assert_eq!(tron_think_sims(0, 10), -1); // not placed yet
        assert_eq!(tron_spawn(0, 30, 0), 0);
        assert_eq!(tron_spawn(3, 1, 1), 0);
        assert_eq!(tron_spawn(0, 1, 1), 1);
        assert_eq!(tron_spawn(0, 2, 2), 0); // twice
        assert_eq!(tron_spawn(1, 1, 1), 0); // same cell
        assert_eq!(tron_spawn(1, 10, 10), 1);
        assert_eq!(tron_to_move(), -1); // set up is not finished
        assert_eq!(tron_spawn(2, 20, 10), 1);
        assert_eq!(tron_to_move(), 0);
        assert_eq!(tron_spawn(2, 21, 10), 0); // too late
        assert_eq!(tron_play(0, 2), 1); // (1, 1) -> (0, 1)
        assert_eq!(tron_play(1, 2), 1);
        assert_eq!(tron_play(2, 0), 1);
        assert_eq!(tron_play(0, 2), 0); // x = 0 now: left is off the board
        assert_eq!(tron_play(0, 7), 0);
    }

    #[test]
    fn eliminate_mid_game() {
        let _g = lock();
        setup(4);
        for _ in 0..6 {
            let p = tron_to_move();
            let d = tron_think_sims(p, 30);
            assert_eq!(tron_play(p, d), 1);
        }
        assert_eq!(tron_to_move(), 2);
        // Not the mover: player 3 goes out, the turn stays with 2.
        assert_eq!(tron_eliminate(3), 1);
        assert_eq!(tron_alive(3), 0);
        assert_eq!(tron_to_move(), 2);
        assert_eq!(tron_eliminate(3), 0); // already out
        assert_eq!(tron_think_sims(3, 10), -1);
        // The mover: the turn passes to the next living player (0).
        assert_eq!(tron_eliminate(2), 1);
        assert_eq!(tron_to_move(), 0);
        assert_eq!(tron_over(), 0);
        assert_eq!(tron_winner(), -1);
        let d = tron_think_sims(0, 50);
        assert!((0..4).contains(&d));
        assert_eq!(tron_play(0, d), 1);
        assert_eq!(tron_to_move(), 1);
        // Down to one: the game is over and the survivor wins.
        assert_eq!(tron_eliminate(1), 1);
        assert_eq!(tron_over(), 1);
        assert_eq!(tron_winner(), 0);
        assert_eq!(tron_to_move(), -1);
        assert_eq!(tron_eliminate(0), 0); // nothing to do after the end
    }
}
