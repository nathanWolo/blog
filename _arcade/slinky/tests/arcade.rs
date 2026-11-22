//! Native tests with the real weights. Skipped (with a message) when the weights are absent.
use slinky_api::Request;
use slinky_arcade::{tie_seed, Arcade};
use slinky_net::Network;
use slinky_rules::Mode;
use slinky_search::Agent;
use std::path::Path;

// The weights the site serves, so the tests check the files the page will load.
const WEIGHTS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../assets/wasm/slinky-weights");

fn load() -> Option<Arcade> {
    let dir = Path::new(WEIGHTS);
    let (c, p) = (dir.join("config.json"), dir.join("params.npz"));
    if !c.exists() || !p.exists() {
        eprintln!("SKIP: weights not found at {WEIGHTS}");
        return None;
    }
    Some(Arcade::new(&std::fs::read_to_string(c).unwrap(), &std::fs::read(p).unwrap()).unwrap())
}

fn json(a: &Arcade) -> serde_json::Value {
    serde_json::from_slice(a.state_json()).expect("state JSON parses")
}

/// Play a whole game, every snake by `think` at `sims`; assert legality each turn. Returns the
/// moves played (one row per turn) and the final JSON.
fn play(a: &mut Arcade, n: usize, sims: i32) -> (Vec<[i32; 4]>, serde_json::Value) {
    let mut log = Vec::new();
    loop {
        let (cfg, st) = a.game().map(|(c, s)| (*c, *s)).unwrap();
        if st.done {
            break;
        }
        let legal = st.legal_moves(cfg.rules());
        let mut mv = [0i32; 4];
        for s in 0..n {
            let m = a.think(s as i32, sims, 0).unwrap();
            if st.alive[s] {
                assert!((0..4).contains(&m), "alive snake {s} got {m}");
                assert!(legal[s][m as usize], "illegal move {m} for snake {s} at turn {}", st.turn);
                assert_eq!(a.last_sims(), sims, "exactly the requested simulations");
            } else {
                assert_eq!(m, -1);
            }
            mv[s] = m;
        }
        // Reading the JSON between thinks must work, and thinking must not change the state.
        let j = json(a);
        assert_eq!(j["turn"].as_i64().unwrap(), st.turn as i64);
        log.push(mv);
        let over = a.step(mv).unwrap();
        assert_eq!(over, a.game().unwrap().1.done);
        assert!(log.len() < 2000, "game did not end");
    }
    (log, json(a))
}

#[test]
fn full_duel() {
    let Some(mut a) = load() else { return };
    a.new_game(1, 2, 7).unwrap();
    let (log, j) = play(&mut a, 2, 64);
    assert!(j["over"].as_bool().unwrap());
    eprintln!("duel: {} turns, winner {}", log.len(), j["winner"]);
    assert_eq!(j["mode"], "duel");
    assert_eq!(a.think(0, 64, 0).unwrap(), -1);
    assert!(a.step([0; 4]).is_err());
}

#[test]
fn full_four_snake_standard() {
    let Some(mut a) = load() else { return };
    a.new_game(0, 4, 12345).unwrap();
    let (log, j) = play(&mut a, 4, 64);
    assert!(j["over"].as_bool().unwrap());
    assert_eq!(j["snakes"].as_array().unwrap().len(), 4);
    eprintln!("standard x4: {} turns, winner {}", log.len(), j["winner"]);
}

#[test]
fn every_mode_runs() {
    let Some(mut a) = load() else { return };
    for (mode, n) in [(0, 3), (2, 2), (2, 4), (3, 2), (3, 4)] {
        a.new_game(mode, n, 99).unwrap();
        let (log, j) = play(&mut a, n as usize, 16);
        eprintln!("mode {mode} x{n}: {} turns, winner {}", log.len(), j["winner"]);
    }
    assert!(a.new_game(1, 3, 0).is_err());
    assert!(a.new_game(0, 2, 0).is_err());
    assert!(a.new_game(4, 2, 0).is_err());
}

#[test]
fn directions_up_is_y_plus_one() {
    let Some(mut a) = load() else { return };
    a.new_game(1, 2, 3).unwrap();
    // Turn 0: both snakes are stacked, a move extends the head one cell.
    let before = json(&a);
    let h0 = before["snakes"][0]["body"][0].clone();
    // Pick a move that stays on the board for snake 0 for each direction in turn.
    for (m, (dx, dy)) in [(0, (0, 1)), (1, (0, -1)), (2, (-1, 0)), (3, (1, 0))] {
        a.new_game(1, 2, 3).unwrap();
        let (x, y) = (h0[0].as_i64().unwrap(), h0[1].as_i64().unwrap());
        let (nx, ny) = (x + dx, y + dy);
        if !(0..11).contains(&nx) || !(0..11).contains(&ny) {
            continue;
        }
        a.step([m, 0, 0, 0]).unwrap();
        let after = json(&a);
        if after["snakes"][0]["alive"].as_bool().unwrap() {
            assert_eq!(after["snakes"][0]["body"][0], serde_json::json!([nx, ny]), "move {m}");
        }
    }
}

/// `think` equals what the upstream Agent returns for the same request and settings, with a
/// fresh agent each time (no reuse): along a 4-snake standard game (rescaled values) and a duel.
#[test]
fn think_equals_upstream_agent() {
    let Some(mut a) = load() else { return };
    let net = Network::load(WEIGHTS).unwrap();
    let up = Agent::from_network(net).with_simulations(64).with_rescale_q_modes(&[Mode::Standard]);
    let mut compared = 0;
    for (mode, n, seed) in [(0, 4, 5u64), (1, 2, 6), (2, 3, 8), (3, 2, 9)] {
        a.new_game(mode, n, seed).unwrap();
        loop {
            let (_, st) = a.game().map(|(c, s)| (*c, *s)).unwrap();
            if st.done {
                break;
            }
            let mut mv = [0i32; 4];
            for s in 0..n as usize {
                if !st.alive[s] {
                    continue;
                }
                let body = a.request_json(s).unwrap().to_string();
                let id = slinky_arcade::game_id(seed, s);
                let seed32 = tie_seed(&id, &st.turn.to_string());
                let want = up.play(&body, Some(n as usize), seed32).unwrap();
                let got = a.think(s as i32, 64, 0).unwrap();
                assert_eq!(got, want.mv as i32, "mode {mode} snake {s} turn {}", st.turn);
                assert_eq!(a.last_sims() as usize, want.search.simulations);
                assert_eq!(a.last_value(), (want.search.value[0] * 1000.0).round() as i32);
                mv[s] = got;
                compared += 1;
            }
            a.step(mv).unwrap();
        }
    }
    eprintln!("compared {compared} moves against the upstream Agent");
    assert!(compared > 100);
    let _ = Request::from_json; // keep the import honest
}

/// Calling think for several snakes, repeatedly and in any order, gives the same answers.
#[test]
fn think_is_repeatable_and_order_free() {
    let Some(mut a) = load() else { return };
    a.new_game(0, 4, 21).unwrap();
    for _ in 0..10 {
        let fwd: Vec<i32> = (0..4).map(|s| a.think(s, 48, 0).unwrap()).collect();
        let rev: Vec<i32> = (0..4).rev().map(|s| a.think(s, 48, 0).unwrap()).collect();
        let rev: Vec<i32> = rev.into_iter().rev().collect();
        assert_eq!(fwd, rev);
        a.step([fwd[0], fwd[1], fwd[2], fwd[3]]).unwrap();
    }
}

#[test]
fn time_budget_mode() {
    let Some(mut a) = load() else { return };
    a.new_game(1, 2, 4).unwrap();
    let t = std::time::Instant::now();
    let m = a.think(0, 0, 100).unwrap();
    let ms = t.elapsed().as_millis();
    eprintln!("100 ms budget: move {m}, {} sims in {ms} ms", a.last_sims());
    assert!((0..4).contains(&m));
    assert!(a.last_sims() > 1 && ms < 300);
}
