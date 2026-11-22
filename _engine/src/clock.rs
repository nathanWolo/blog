//! The engine's clock.
//!
//! Natively this is `std::time::Instant`. WebAssembly has no clock of its own,
//! so there the page supplies one: an imported `now_ms` function that returns
//! milliseconds (`performance.now()`), wrapped in a type with the three
//! operations the engine uses.

#[cfg(not(target_arch = "wasm32"))]
pub use std::time::Instant;

#[cfg(target_arch = "wasm32")]
pub use wasm::Instant;

#[cfg(target_arch = "wasm32")]
mod wasm {
    use std::ops::Add;
    use std::time::Duration;

    #[link(wasm_import_module = "env")]
    extern "C" {
        fn now_ms() -> f64;
    }

    #[derive(Clone, Copy, PartialEq, PartialOrd)]
    pub struct Instant(f64);

    impl Instant {
        pub fn now() -> Self {
            Instant(unsafe { now_ms() })
        }

        pub fn elapsed(&self) -> Duration {
            let ms = (Self::now().0 - self.0).max(0.0);
            Duration::from_secs_f64(ms / 1000.0)
        }
    }

    impl Add<Duration> for Instant {
        type Output = Instant;

        fn add(self, rhs: Duration) -> Instant {
            Instant(self.0 + rhs.as_secs_f64() * 1000.0)
        }
    }
}
