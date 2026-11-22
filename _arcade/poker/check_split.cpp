// check_split.cpp - is SplitEngine still upstream's Engine::game_turn?
//
// wasm_api.cpp carries a copy of upstream's Engine::game_turn, cut in two at the agent call
// (SplitEngine::pre and ::post). If upstream changes game_turn, the copy goes stale and still compiles.
// This plays whole games twice from the same seed, with the bot in every seat and a fixed number of
// trials (so the bots are deterministic): once through upstream's Engine::run, once step by step
// through Session, as the page drives it. The action logs, every hand's starting chips, the showdowns
// and the final stacks, scores and ranks must be identical. This is step 2 of "Moving to a newer
// upstream commit" in README.md; check.sh builds and runs it natively (no Emscripten needed).
//
//   g++ -std=c++20 -O2 -pthread -I/path/to/cgpoker -o check_split check_split.cpp
//   ./check_split [games per table size, default 20] [trials, default 256]
#define PK_NO_EXPORTS
#include "wasm_api.cpp"

#include <cstdlib>
#include <sstream>

namespace {

struct BotAgent : pk::Agent {            // as arena/arena.cpp drives the bot
  bot::Bot b;
  bot::Budget budget;
  bool act(const pk::Obs& o, std::string& out) override {
    out = b.act(o, budget, bot::Clock::now());
    return true;
  }
};

// Everything a game leaves behind that the two runs must agree on, as text.
std::string record(const pk::Engine& e, const std::string& thrown) {
  std::ostringstream o;
  o << "hands " << e.hand_nb << " rounds " << e.turn << " cancelled " << e.cancelled << " over " << e.game_over
    << " thrown [" << thrown << "]\n";
  for (auto& p : e.players)
    o << "player " << p.id << " stack " << p.stack << " score " << p.score << " rank " << p.elim_rank << " out " << p.eliminated << "\n";
  for (size_t i = 0; i < e.replaced.size(); i++) o << "replaced " << i << " " << e.replaced[i] << "\n";
  for (auto& h : e.hand_starts) {
    o << "hand " << h.hand << " bb " << h.bb << " seats " << h.bb_id << " " << h.sb_id << " " << h.dealer_id << " chips";
    for (int c : h.chips) o << " " << c;
    o << "\n";
  }
  for (size_t h = 0; h < e.showdowns.size(); h++) {
    o << "showdown " << h << " " << e.showdowns[h].board;
    for (auto& c : e.showdowns[h].cards) o << " " << c;
    o << "\n";
  }
  for (auto& l : e.log) o << "action " << l.turn << " " << l.hand << " " << l.pid << " " << l.shown << "\n";
  return o.str();
}

}  // namespace

int main(int argc, char** argv) {
  int games = argc > 1 ? atoi(argv[1]) : 20;
  bot::Budget budget;
  budget.ms = 0;
  budget.min_trials = argc > 2 ? atoi(argv[2]) : 256;
  budget.max_trials = 100000;
  pe::init();

  long decisions = 0, hands = 0;
  for (int n = 2; n <= 4; n++) {
    for (int g = 0; g < games; g++) {
      int64_t seed = 1000003LL * n + 7919LL * g;

      // upstream's loop
      pk::Engine up(n, seed);
      std::vector<BotAgent> bots(n);
      std::vector<pk::Agent*> agents;
      for (auto& a : bots) { a.b.use_fast = true; a.budget = budget; agents.push_back(&a); }
      std::string up_thrown;
      try { up.run(agents); } catch (const std::exception& e) { up_thrown = e.what(); }

      // the split loop, as the page drives it (every seat a bot)
      pkw::Session s(n, seed, false);
      s.budget = budget;
      std::string split_thrown;
      try {
        s.start();
        for (;;) {
          int r = s.step();
          if (r == 3) break;
          if (r == 1) { fprintf(stderr, "check_split: a game without a human seat waits for one\n"); return 1; }
          if (r == 2 && s.next_hand() != 0) { fprintf(stderr, "check_split: next_hand refused\n"); return 1; }
        }
      } catch (const std::exception& e) { split_thrown = e.what(); }

      std::string want = record(up, up_thrown), got = record(*s.eng, split_thrown);
      if (want != got) {
        // show the first line that differs
        std::istringstream a(want), b(got);
        std::string la, lb;
        int line = 0;
        while (true) {
          bool ha = (bool)std::getline(a, la), hb = (bool)std::getline(b, lb);
          line++;
          if (!ha && !hb) break;
          if (!ha) la = "(nothing more)";
          if (!hb) lb = "(nothing more)";
          if (la != lb) break;
        }
        fprintf(stderr, "check_split: %d players, seed %lld: the split engine and upstream's Engine::run disagree\n"
                        "  first difference, line %d\n  upstream: %s\n  split:    %s\n"
                        "wasm_api.cpp's SplitEngine::pre/post no longer match Engine::game_turn in engine/poker_engine.hpp\n",
                n, (long long)seed, line, la.c_str(), lb.c_str());
        return 1;
      }
      decisions += up.log.size();
      hands += up.hand_nb;
    }
  }
  printf("check_split: %d games (2, 3 and 4 players), %ld hands, %ld decisions: the split engine matches upstream's Engine::run\n",
         3 * games, hands, decisions);
  return 0;
}
