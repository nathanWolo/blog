//! Native checks that the adapted engine plays correctly on a masthead-shaped
//! board: a wide, short grid with a block of walls in the middle.

use super::api::{new_game, play, set_wall, spawn, think};
use super::*;
use std::sync::Mutex;

/// The game and the board statics are global, so the tests take turns.
static SERIAL: Mutex<()> = Mutex::new(());

const COLS: i32 = 55;
const ROWS: i32 = 16;
/// The name plate: columns 16..=38, rows 4..=11.
const PLATE: (i32, i32, i32, i32) = (16, 4, 38, 11);

fn in_plate(col: i32, row: i32) -> bool {
    col >= PLATE.0 && col <= PLATE.2 && row >= PLATE.1 && row <= PLATE.3
}

/// Small deterministic generator, so a failure can be reproduced from its seed.
struct Lcg(u64);

impl Lcg {
    fn below(&mut self, n: i32) -> i32 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((self.0 >> 33) % n as u64) as i32
    }
}

/// A board of our own, kept beside the engine's, to check its moves against.
struct Board {
    blocked: Vec<bool>,
    heads: [(i32, i32); 2],
}

impl Board {
    fn start(rng: &mut Lcg) -> Board {
        assert!(new_game(COLS, ROWS, 2));
        let mut blocked = vec![false; (COLS * ROWS) as usize];
        for row in 0..ROWS {
            for col in 0..COLS {
                if in_plate(col, row) {
                    assert!(set_wall(col, row));
                    blocked[(row * COLS + col) as usize] = true;
                }
            }
        }
        // Red on the left third, blue on the right third, as on the page.
        let heads = [
            (1 + rng.below(13), 1 + rng.below(ROWS - 2)),
            (COLS - 2 - rng.below(13), 1 + rng.below(ROWS - 2)),
        ];
        for (player, &(col, row)) in heads.iter().enumerate() {
            assert!(spawn(player as i32, col, row));
            blocked[(row * COLS + col) as usize] = true;
        }
        Board { blocked, heads }
    }

    fn is_free(&self, col: i32, row: i32) -> bool {
        col >= 0 && col < COLS && row >= 0 && row < ROWS && !self.blocked[(row * COLS + col) as usize]
    }

    fn target(&self, player: usize, dir: i32) -> (i32, i32) {
        let (col, row) = self.heads[player];
        (col + DIR_X[dir as usize], row + DIR_Y[dir as usize])
    }

    fn has_move(&self, player: usize) -> bool {
        (0..4).any(|dir| {
            let (col, row) = self.target(player, dir);
            self.is_free(col, row)
        })
    }

    /// Make `dir` for `player` on both boards, checking that it is legal.
    fn advance(&mut self, player: usize, dir: i32) {
        let (col, row) = self.target(player, dir);
        assert!(self.is_free(col, row), "player {player} moved into a blocked cell at ({col}, {row})");
        assert!(play(player as i32, dir));
        self.blocked[(row * COLS + col) as usize] = true;
        self.heads[player] = (col, row);
    }

    /// A naive opponent: the first free direction.
    fn first_free(&self, player: usize) -> i32 {
        (0..4)
            .find(|&dir| {
                let (col, row) = self.target(player, dir);
                self.is_free(col, row)
            })
            .unwrap()
    }
}

/// Plays one game and returns the winner. `engine_plays[player]` says whether
/// that bike is driven by the engine or by the naive opponent.
fn play_game(seed: u64, engine_plays: [bool; 2], budget_ms: i32) -> usize {
    let mut rng = Lcg(seed);
    let mut board = Board::start(&mut rng);
    for ply in 0..(COLS * ROWS * 2) as usize {
        let player = ply % 2;
        if !board.has_move(player) {
            assert_eq!(think(player as i32, budget_ms), -1, "the engine saw a move where there is none");
            return 1 - player;
        }
        let dir = if engine_plays[player] {
            think(player as i32, budget_ms)
        } else {
            board.first_free(player)
        };
        assert!((0..4).contains(&dir), "seed {seed}: no direction returned on ply {ply}");
        board.advance(player, dir);
    }
    panic!("seed {seed}: the game did not end");
}

#[test]
fn engine_games_are_legal_and_end() {
    let _turn = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    for seed in 1..=6 {
        play_game(seed, [true, true], 2);
    }
}

#[test]
fn engine_beats_a_naive_opponent() {
    let _turn = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut wins = 0;
    for seed in 1..=10u64 {
        // Alternate which colour the engine plays.
        let engine_side = (seed % 2) as usize;
        let mut engine_plays = [false, false];
        engine_plays[engine_side] = true;
        if play_game(seed + 100, engine_plays, 2) == engine_side {
            wins += 1;
        }
    }
    assert_eq!(wins, 10, "the engine won {wins} of 10 games against the naive opponent");
}

#[test]
fn walls_stay_walls() {
    let _turn = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    assert!(new_game(COLS, ROWS, 2));
    assert!(set_wall(20, 8));
    assert!(!set_wall(20, 8), "a wall cannot be set twice");
    assert!(!set_wall(COLS, 0), "cells outside the grid are already walls");
    assert!(!spawn(0, 20, 8), "a bike cannot start on a wall");
    assert!(spawn(0, 19, 8));
    assert!(!play(0, 3), "moving right from (19, 8) runs into the wall");
    assert!(play(0, 2));
    assert!(!new_game(65, 16, 2) && !new_game(55, 21, 2), "the grid is at most 64 x 20");
}
