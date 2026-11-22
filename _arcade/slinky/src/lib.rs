//! slinky_arcade: a browser-sized wrapper around the slinky Battlesnake engine.
//!
//! The game rules, food spawning, observations, network and PUCT search are the upstream crates
//! (nathanWolo/slinky, `native/`), used unmodified. This crate adds only a one-game-at-a-time
//! facade ([`Arcade`]) and a C ABI over it (the `bs_*` exports, see README.md).
//!
//! The agent is configured the way the deployed "AlphaSlinky" function (`/az-t200`, see
//! `deploy/lambda-native/README.md` and `crates/lambda/src/engine.rs` upstream) is:
//!
//! * one search tree (`threads = 1`), rescaled values in standard games (`RESCALE_Q=standard`);
//! * tree reuse on (`REUSE=1`): each snake keeps its own [`Search`] workspace for the whole
//!   game, so the next turn's search copies the network evaluations of the nodes it shares with
//!   the previous tree (bit-identical moves, only faster);
//! * time budget mode: stop at the deadline, at most 16,384 simulations (`BUDGET_SIMULATIONS`),
//!   early stop off (the deployed `BUDGET_MS` snake keeps it off while reuse is on);
//! * fixed-simulation mode: exactly N simulations. The deployed `/az-256` also has the early stop
//!   on, which never changes the move but can run fewer simulations. Here it is off so that
//!   "N simulations" means N;
//! * tie-break noise seed `tie_seed(game id, turn)` (the lambda's FNV-1a hash), the game id being
//!   derived from the game seed and the snake index;
//! * memory cap 256 MiB per tree (`MEMORY_LIMIT_MB` default);
//! * each move is searched from a Battlesnake `/move` request built with
//!   `slinky_env::to_request_json` and read back with `slinky_api::game_from_request`, with the
//!   snake count at the start passed as `starting_snakes` (what `/start` gives the server), so
//!   the agent sees exactly what it would see over HTTP.

use std::cell::RefCell;
use std::time::{Duration, Instant};

use serde_json::Value;
use slinky_api::{game_from_request, Request};
use slinky_env::{body_segments, to_request_json, EnvConfig, Game, MapKind};
use slinky_net::{NetConfig, Network};
use slinky_rules::{GameConfig, GameState, Mode};
use slinky_search::{Agent, Budget, JaxNoise, Search};

/// Cap on simulations of a time-budget search (`BUDGET_SIMULATIONS` upstream).
pub const BUDGET_SIMULATIONS: usize = 16384;
/// Per-tree memory cap in bytes (`MEMORY_LIMIT_MB` default upstream).
pub const MEMORY_LIMIT: usize = 256 << 20;
/// Used when `bs_think` gets neither simulations nor a budget.
pub const DEFAULT_BUDGET_MS: i32 = 200;

/// The lambda's tie-noise seed: FNV-1a over the game id, a 0xff separator and the turn text.
pub fn tie_seed(game_id: &str, turn: &str) -> u32 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in game_id.bytes().chain([0xff]).chain(turn.bytes()) {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    (h ^ (h >> 32)) as u32
}

/// The game id the request of `snake` carries in the game started with `seed`.
pub fn game_id(seed: u64, snake: usize) -> String {
    format!("arcade-{seed:016x}-s{snake}")
}

struct Slot {
    game: Game,
    seed: u64,
    n: usize,
    /// One search workspace per snake: its tree is kept between its moves (tree reuse).
    ws: Vec<Search>,
}

/// One game at a time, with the loaded network.
pub struct Arcade {
    agent: Agent,
    slot: Option<Slot>,
    state_json: Vec<u8>,
    last_sims: i32,
    last_value: i32,
}

fn ladder_env(mode: i32, snakes: i32) -> Result<EnvConfig, String> {
    let mode = match mode {
        0 => Mode::Standard,
        1 => Mode::Duel,
        2 => Mode::Royale,
        3 => Mode::Constrictor,
        _ => return Err(format!("mode {mode} is not 0 standard, 1 duel, 2 royale or 3 constrictor")),
    };
    if !(2..=4).contains(&snakes) {
        return Err(format!("snakes must be 2 to 4, not {snakes}"));
    }
    let rules = GameConfig::for_mode(mode, Some(snakes as usize)).map_err(|e| e.to_string())?;
    // The ladder's maps (EnvConfig::ladder): royale on the royale map, constrictor on the empty
    // map (no food), the others standard.
    let map = match mode {
        Mode::Royale => MapKind::Royale,
        Mode::Constrictor => MapKind::Empty,
        Mode::Standard | Mode::Duel => MapKind::Standard,
    };
    EnvConfig::new(rules, map).map_err(|e| e.to_string())
}

impl Arcade {
    /// Load the network from the bytes of `config.json` and `params.npz`.
    pub fn new(config_json: &str, npz: &[u8]) -> Result<Arcade, String> {
        let cfg = NetConfig::from_json(config_json).map_err(|e| format!("config.json: {e}"))?;
        let net = Network::from_npz_bytes(cfg, npz).map_err(|e| format!("params.npz: {e}"))?;
        // Deployed setup: one tree, rescaled values in standard games. The budget, early stop
        // and reuse are set per search (see `think`).
        let agent = Agent::from_network(net)
            .with_threads(1)
            .with_memory_limit(MEMORY_LIMIT)
            .with_rescale_q_modes(&[Mode::Standard]);
        Ok(Arcade { agent, slot: None, state_json: Vec::new(), last_sims: 0, last_value: 0 })
    }

    /// Start a new game (replaces the current one, drops every tree).
    pub fn new_game(&mut self, mode: i32, snakes: i32, seed: u64) -> Result<(), String> {
        let env = ladder_env(mode, snakes)?;
        let game = Game::new(env, seed);
        let n = env.rules().num_snakes();
        self.slot = Some(Slot {
            game,
            seed,
            n,
            ws: (0..n).map(|_| Search::with_memory_limit(MEMORY_LIMIT)).collect(),
        });
        self.last_sims = 0;
        self.last_value = 0;
        self.refresh_json();
        Ok(())
    }

    /// The environment and state of the current game.
    pub fn game(&self) -> Option<(&EnvConfig, &GameState)> {
        self.slot.as_ref().map(|s| (&s.game.config, &s.game.state))
    }

    /// The `/move` request of `snake` at the current state (None if dead or no game).
    pub fn request_json(&self, snake: usize) -> Option<Value> {
        let s = self.slot.as_ref()?;
        to_request_json(&s.game.config, &s.game.state, snake, &game_id(s.seed, snake))
    }

    /// The agent's move for `snake` (0 up, 1 down, 2 left, 3 right), or -1 if that snake is dead
    /// or the game is over. `sims > 0`: exactly that many simulations, deterministic; otherwise
    /// search until `budget_ms` (default 200) has passed, at most 16,384 simulations. Does not
    /// change the game; only that snake's own search tree.
    pub fn think(&mut self, snake: i32, sims: i32, budget_ms: i32) -> Result<i32, String> {
        let arrival = Instant::now();
        let Some(slot) = self.slot.as_mut() else { return Err("no game".into()) };
        if slot.game.state.done || snake < 0 || snake as usize >= slot.n || !slot.game.state.alive[snake as usize] {
            return Ok(-1);
        }
        let snake = snake as usize;
        let id = game_id(slot.seed, snake);
        let body = to_request_json(&slot.game.config, &slot.game.state, snake, &id)
            .ok_or("snake is not alive")?;
        let req = Request::from_value(&body).map_err(|e| e.to_string())?;
        // `starting_snakes` = the snake count at /start.
        let game = game_from_request(&req, Some(slot.n)).map_err(|e| e.to_string())?;
        let budget = if sims > 0 {
            Budget::simulations(sims as usize)
        } else {
            let ms = if budget_ms > 0 { budget_ms } else { DEFAULT_BUDGET_MS };
            Budget::until(BUDGET_SIMULATIONS, arrival + Duration::from_millis(ms as u64))
        };
        let ws = &mut slot.ws[snake];
        ws.set_stop_when_decided(None);
        if !ws.reuse() {
            ws.set_reuse(true);
        }
        let seed = tie_seed(&id, &slot.game.state.turn.to_string());
        let m = self
            .agent
            .search_game(ws, &game, budget, &mut JaxNoise::from_seed(seed))
            .map_err(|e| e.to_string())?;
        self.last_sims = m.search.simulations as i32;
        self.last_value = (m.search.value[0] * 1000.0).round() as i32;
        Ok(m.mv as i32)
    }

    /// Apply one simultaneous turn. Returns whether the game is now over.
    pub fn step(&mut self, moves: [i32; 4]) -> Result<bool, String> {
        let slot = self.slot.as_mut().ok_or("no game")?;
        if slot.game.state.done {
            return Err("the game is over".into());
        }
        let mut actions = [0u8; 4];
        for i in 0..slot.n {
            actions[i] = u8::try_from(moves[i]).unwrap_or(255); // >= 4 repeats the last move
        }
        let info = slot.game.step(&actions);
        self.refresh_json();
        Ok(info.done)
    }

    pub fn state_json(&self) -> &[u8] {
        &self.state_json
    }
    pub fn last_sims(&self) -> i32 {
        self.last_sims
    }
    pub fn last_value(&self) -> i32 {
        self.last_value
    }

    fn refresh_json(&mut self) {
        self.state_json = match &self.slot {
            Some(s) => state_to_json(&s.game.config, &s.game.state).into_bytes(),
            None => Vec::new(),
        };
    }
}

fn pt((x, y): (i32, i32)) -> Value {
    Value::Array(vec![x.into(), y.into()])
}

fn state_to_json(env: &EnvConfig, st: &GameState) -> String {
    let cfg = env.rules();
    let n = cfg.num_snakes();
    let mut food = Vec::new();
    let mut hazards = Vec::new();
    for c in 0..cfg.cells() {
        if st.has_food(c) {
            food.push(pt(cfg.xy(c)));
        }
        if st.hazard[c] > 0 {
            hazards.push(pt(cfg.xy(c)));
        }
    }
    let snakes: Vec<Value> = (0..n)
        .map(|i| {
            let body = body_segments(env, st, i);
            let alive = st.alive[i];
            serde_json::json!({
                "alive": alive,
                "health": if alive { st.health[i] } else { 0 },
                "length": body.len(),
                "body": body.into_iter().map(pt).collect::<Vec<_>>(),
            })
        })
        .collect();
    let over = st.done;
    let alive: Vec<usize> = (0..n).filter(|&i| st.alive[i]).collect();
    let winner: i64 = if over && alive.len() == 1 { alive[0] as i64 } else { -1 };
    serde_json::json!({
        "turn": st.turn,
        "width": cfg.width(),
        "height": cfg.height(),
        "mode": cfg.mode().name(),
        "food": food,
        "hazards": hazards,
        "hazard_damage": if cfg.mode() == Mode::Royale { cfg.hazard_damage_per_turn() } else { 0 },
        "snakes": snakes,
        "over": over,
        "winner": winner,
    })
    .to_string()
}

// ---------------------------------------------------------------------------------------------
// C ABI. One game at a time, in a thread-local (the wasm module is single-threaded).
// ---------------------------------------------------------------------------------------------

thread_local! {
    static ARCADE: RefCell<Option<Arcade>> = const { RefCell::new(None) };
    static ERROR: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    /// Mirror of the state JSON, so the pointer stays valid whatever else happens.
    static STATE: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn set_error(msg: &str) {
    ERROR.with(|e| *e.borrow_mut() = msg.as_bytes().to_vec());
}

fn sync_state() {
    ARCADE.with(|a| {
        let json = a.borrow().as_ref().map(|a| a.state_json().to_vec()).unwrap_or_default();
        STATE.with(|s| *s.borrow_mut() = json);
    });
}

/// Allocate `len` zeroed bytes the host can write into. Free with `bs_free(ptr, len)`.
#[no_mangle]
pub extern "C" fn bs_alloc(len: u32) -> *mut u8 {
    let mut v = vec![0u8; len as usize];
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr` must come from `bs_alloc(len)` with the same `len`, and not be freed twice.
#[no_mangle]
pub unsafe extern "C" fn bs_free(ptr: *mut u8, len: u32) {
    if !ptr.is_null() {
        drop(Vec::from_raw_parts(ptr, len as usize, len as usize));
    }
}

/// Load the network (once). 0 on success, else see `bs_error_ptr`/`bs_error_len`.
///
/// # Safety
/// The pointers must be valid for their lengths.
#[no_mangle]
pub unsafe extern "C" fn bs_init(config_ptr: *const u8, config_len: u32, npz_ptr: *const u8, npz_len: u32) -> i32 {
    let cfg = std::slice::from_raw_parts(config_ptr, config_len as usize);
    let npz = std::slice::from_raw_parts(npz_ptr, npz_len as usize);
    let res = std::str::from_utf8(cfg)
        .map_err(|e| format!("config.json is not UTF-8: {e}"))
        .and_then(|t| Arcade::new(t, npz));
    match res {
        Ok(a) => {
            ARCADE.with(|s| *s.borrow_mut() = Some(a));
            sync_state();
            0
        }
        Err(e) => {
            set_error(&e);
            1
        }
    }
}

/// New game: `mode` 0 standard, 1 duel, 2 royale, 3 constrictor; `snakes` 2..=4. 0 on success.
#[no_mangle]
pub extern "C" fn bs_new_game(mode: i32, snakes: i32, seed_lo: u32, seed_hi: u32) -> i32 {
    let seed = (u64::from(seed_hi) << 32) | u64::from(seed_lo);
    let r = ARCADE.with(|a| match a.borrow_mut().as_mut() {
        Some(a) => a.new_game(mode, snakes, seed),
        None => Err("bs_init has not succeeded".to_string()),
    });
    sync_state();
    match r {
        Ok(()) => 0,
        Err(e) => {
            set_error(&e);
            1
        }
    }
}

#[no_mangle]
pub extern "C" fn bs_state_ptr() -> *const u8 {
    STATE.with(|s| s.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn bs_state_len() -> u32 {
    STATE.with(|s| s.borrow().len() as u32)
}

/// The agent's move for `snake` (0 up, 1 down, 2 left, 3 right; up is y+1), -1 if dead, the game
/// is over or on error (then see `bs_error_ptr`). `sims > 0`: exactly that many simulations,
/// else the time budget `budget_ms` (200 if not positive).
#[no_mangle]
pub extern "C" fn bs_think(snake: i32, sims: i32, budget_ms: i32) -> i32 {
    let r = ARCADE.with(|a| match a.borrow_mut().as_mut() {
        Some(a) => a.think(snake, sims, budget_ms),
        None => Err("bs_init has not succeeded".to_string()),
    });
    match r {
        Ok(m) => m,
        Err(e) => {
            set_error(&e);
            -1
        }
    }
}

/// Apply one turn. 1 if the game is now over, 0 if not, -1 on error.
#[no_mangle]
pub extern "C" fn bs_step(m0: i32, m1: i32, m2: i32, m3: i32) -> i32 {
    let r = ARCADE.with(|a| match a.borrow_mut().as_mut() {
        Some(a) => a.step([m0, m1, m2, m3]),
        None => Err("bs_init has not succeeded".to_string()),
    });
    sync_state();
    match r {
        Ok(over) => over as i32,
        Err(e) => {
            set_error(&e);
            -1
        }
    }
}

#[no_mangle]
pub extern "C" fn bs_last_sims() -> i32 {
    ARCADE.with(|a| a.borrow().as_ref().map_or(0, |a| a.last_sims()))
}

#[no_mangle]
pub extern "C" fn bs_last_value() -> i32 {
    ARCADE.with(|a| a.borrow().as_ref().map_or(0, |a| a.last_value()))
}

#[no_mangle]
pub extern "C" fn bs_error_ptr() -> *const u8 {
    ERROR.with(|e| e.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn bs_error_len() -> u32 {
    ERROR.with(|e| e.borrow().len() as u32)
}
