// std::uniform_int_distribution is implementation-defined: libc++ (Emscripten) and libstdc++ (the
// native g++ build) turn the same std::mt19937_64 stream into different numbers. Upstream's
// GlobalBoard constructor derives its Zobrist keys that way, so without this shim the wasm engine
// uses slightly different hash keys than the native/CodinGame one and, at depth >= ~10, its
// transposition-table collisions (hence node counts) drift from the native engine's.
// This reproduces libstdc++'s algorithm for a 64-bit generator with a full 64-bit range
// (GCC 11+: Lemire's nearly-divisionless method on a 128-bit product) and maps upstream's
// `std::uniform_int_distribution` onto it. Include AFTER the standard headers upstream uses
// (so no library header sees the macro), BEFORE upstream's source.
#pragma once
#include <random>
#include <cstdint>
#include <algorithm>
#include <numeric>
#include <future>
#include <thread>
#include <mutex>
#include <stack>
#include <chrono>

namespace cf_shim {
template <class T = uint64_t>
struct uniform_int {
    static_assert(sizeof(T) == 8, "only the 64-bit case upstream uses is reproduced");
    T a_, b_;
    uniform_int(T a, T b) : a_(a), b_(b) {}
    template <class G>
    T operator()(G &g) {
        static_assert(G::min() == 0 && G::max() == UINT64_MAX, "needs a full-range 64-bit generator");
        const uint64_t range = (uint64_t)(b_ - a_) + 1;  // not 0 for upstream's (1, 2^64-2)
        unsigned __int128 prod = (unsigned __int128)(uint64_t)g() * range;
        uint64_t low = (uint64_t)prod;
        if (low < range) {
            const uint64_t threshold = -range % range;
            while (low < threshold) {
                prod = (unsigned __int128)(uint64_t)g() * range;
                low = (uint64_t)prod;
            }
        }
        return (T)(prod >> 64) + a_;
    }
};
}  // namespace cf_shim
namespace std {
template <class T>
using cf_uniform_int_distribution = ::cf_shim::uniform_int<T>;
}
#define uniform_int_distribution cf_uniform_int_distribution
