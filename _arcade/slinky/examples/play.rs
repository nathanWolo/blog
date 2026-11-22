//! Native reference game for comparing with the wasm build.
//! `cargo run --release --example play -- <weights dir> <mode> <snakes> <seed> <sims>`
//! Prints one line of moves per turn (like bs_smoke.py does), then the final state JSON.
use slinky_arcade::Arcade;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let dir = std::path::Path::new(&a[1]);
    let (mode, n, seed, sims): (i32, i32, u64, i32) =
        (a[2].parse().unwrap(), a[3].parse().unwrap(), a[4].parse().unwrap(), a[5].parse().unwrap());
    let mut g = Arcade::new(
        &std::fs::read_to_string(dir.join("config.json")).unwrap(),
        &std::fs::read(dir.join("params.npz")).unwrap(),
    )
    .unwrap();
    g.new_game(mode, n, seed).unwrap();
    let mut turn = 0;
    loop {
        let mut mv = [0i32; 4];
        for s in 0..n {
            mv[s as usize] = g.think(s, sims, 0).unwrap();
        }
        println!("{turn} {} {} {} {}", mv[0], mv[1], mv[2], mv[3]);
        turn += 1;
        if g.step(mv).unwrap() {
            break;
        }
    }
    println!("{}", String::from_utf8_lossy(g.state_json()));
}
