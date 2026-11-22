#!/usr/bin/env bash
# Move one Arcade engine to a newer commit of its repository: rebuild it from a checkout, run the
# checks that compare the build with the original engine, and only then move the pin.
# The arcade-engines workflow (.github/workflows/arcade-engines.yml) is built on this script; it
# works by hand too (see README.md, "Following the engine repositories").
#
#   update.sh repo    <engine>                    the engine's repository, as owner/name
#   update.sh pinned  <engine>                    the upstream commit the Arcade is built from now
#   update.sh changed <engine> <checkout>         prints "changed" if the checkout differs from the
#                                                 pinned commit in what the build reads, else "unchanged"
#   update.sh rebuild <engine> <checkout>         derive or build from the checkout, run the checks,
#                                                 move the pin; stops at the first thing that fails
#   update.sh notes   <engine> <checkout> <from>  the pull request text for a rebuild that moved
#                                                 the pin from commit <from>
#   update.sh apply   <engine> <folder>           in a clean checkout of the site: stage the update a
#                                                 rebuild left in <folder> (update.patch and
#                                                 upstream-commit, as the workflow's build job packs
#                                                 them), refusing one that reaches outside the
#                                                 engine's own folder and built file; prints the
#                                                 upstream commit
#
# <engine> is tronzero, slinky, crossfish or poker. <checkout> is a clone of its repository, with
# history, at the commit to move to. A failed rebuild commits nothing, but it can leave part of the
# update in the working tree (git status shows it).
#
# Needs: Rust with the wasm32-wasip1 target (tronzero, slinky), Emscripten and g++ (crossfish,
# poker), Python 3 (tronzero) and Node. Env: EMSDK (default /opt/emsdk), CARGO_TARGET_DIR,
# PYTHON (default python3), NODE (default node; for crossfish and poker the one Emscripten brings).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

die() {
  [ -z "${GITHUB_ACTIONS:-}" ] || echo "::error title=Arcade engines::$*"
  echo "update.sh: $*" >&2
  exit 1
}

CMD="${1:-}"; ENGINE="${2:-}"; CHECKOUT="${3:-}"
case "$ENGINE" in
  # READS: the upstream paths the build reads, or whose settings this folder repeats by hand.
  tronzero)  REPO=nathanWolo/tron-codingame; TITLE="Tron (tronzero)";                  READS="engine/src paste/net_packed.txt" ;;
  slinky)    REPO=nathanWolo/slinky;         TITLE="Battlesnake (AlphaSlinky)";        READS="native deploy/lambda-native/deploy.sh" ;;
  crossfish) REPO=nathanWolo/crossfish;      TITLE="Ultimate Tic-Tac-Toe (crossfish)"; READS="cpp_impl" ;;
  poker)     REPO=nathanWolo/cgpoker;        TITLE="Poker (cgpoker)";                  READS="engine bot cpp" ;;
  *) die "usage: update.sh repo|pinned|changed|rebuild|notes|apply <tronzero|slinky|crossfish|poker> [checkout|folder] [from]" ;;
esac
WASM="$ROOT/assets/wasm/$ENGINE.wasm"

# The commit the Arcade is built from: where each engine's folder records it.
pinned() {
  local pin
  case "$ENGINE" in
    tronzero)  pin="$(sed -n 's|^// Derived from github.com/nathanWolo/tron-codingame at commit \([0-9a-f]*\)$|\1|p' "$HERE/tronzero/src/upstream/board.rs")" ;;
    slinky)    pin="$(sed -n 's|^slinky-search *=.*rev = "\([0-9a-f]*\)".*|\1|p' "$HERE/slinky/Cargo.toml")" ;;
    crossfish|poker) pin="$(sed -n 's|^PINNED=\([0-9a-f]*\).*|\1|p' "$HERE/$ENGINE/build.sh")" ;;
  esac
  case "$pin" in
    *[!0-9a-f]*|"") die "$ENGINE: could not read the pinned commit" ;;
  esac
  [ "${#pin}" -ge 7 ] || die "$ENGINE: the pinned commit '$pin' is too short"
  echo "$pin"
}

# git in the checkout (which may belong to another user, e.g. a Windows drive seen from WSL)
upgit() { git -c safe.directory='*' -C "$CHECKOUT" "$@"; }

need_checkout() {
  [ -n "$CHECKOUT" ] && [ -d "$CHECKOUT" ] || die "$ENGINE: give a checkout of $REPO"
  CHECKOUT="$(cd "$CHECKOUT" && pwd)"
  upgit rev-parse HEAD >/dev/null 2>&1 || die "$CHECKOUT is not a git checkout"
}

# ---------------------------------------------------------------- rebuild
STEP=""
step() {
  [ -z "${GITHUB_ACTIONS:-}" ] || { [ -z "$STEP" ] || echo "::endgroup::"; echo "::group::$ENGINE: $*"; }
  [ -n "${GITHUB_ACTIONS:-}" ] || echo "== $ENGINE: $*"
  STEP="$*"
}
finish() {
  local code=$?
  [ -z "${GITHUB_ACTIONS:-}" ] || [ -z "$STEP" ] || echo "::endgroup::"
  [ "$code" = 0 ] && return
  local message="$ENGINE: stopped at \"$STEP\". $REPO at ${NEW:0:7} was not accepted and the Arcade stays on $OLD."
  [ -z "${GITHUB_ACTIONS:-}" ] || echo "::error title=Arcade engines::$message Nothing was committed and no pull request was opened."
  echo "update.sh: $message" >&2
}

node_from_emscripten() {   # the C++ modules are checked with the Node of the toolchain that built them
  [ -n "${NODE:-}" ] && return
  # shellcheck disable=SC1091
  source "${EMSDK:-/opt/emsdk}/emsdk_env.sh" >/dev/null 2>&1
  NODE=node
}

rebuild_tronzero() {
  cd "$HERE/tronzero"
  # src/lib.rs repeats two search settings from upstream's main.rs, which is not derived.
  step "upstream's search settings against src/lib.rs"
  local name theirs ours
  for name in C_PUCT FPU_REDUCTION; do
    theirs="$(sed -n "s/^pub const $name: f32 = \(.*\);.*/\1/p" "$CHECKOUT/engine/src/main.rs")"
    ours="$(sed -n "s/^pub const $name: f32 = \(.*\);.*/\1/p" src/lib.rs)"
    [ -n "$theirs" ] && [ "$theirs" = "$ours" ] \
      || die "tronzero: upstream's $name (engine/src/main.rs) is '${theirs:-not found}' and src/lib.rs has '$ours': change src/lib.rs to match"
    echo "$name = $ours"
  done
  step "derive the sources from the checkout (derive.py stops if upstream changed shape)"
  "$PYTHON" derive.py "$CHECKOUT" "$NEW"
  step "native tests (cargo test --release: whole 2- and 4-player games)"
  cargo test --release
  step "build tronzero.wasm"
  bash build.sh
  step "play the built file under Node"
  "${NODE:-node}" "$HERE/check_wasm.mjs" tronzero
}

rebuild_slinky() {
  cd "$HERE/slinky"
  local weights="$ROOT/assets/wasm/slinky-weights" f
  for f in config.json params.npz; do
    [ -f "$weights/$f" ] || die "slinky: $weights/$f is missing, and the tests would skip without it"
  done
  step "pin Cargo.toml and Cargo.lock to $NEW"
  sed -i "s|\(github.com/nathanWolo/slinky\", rev = \"\)[0-9a-f]*\"|\1$NEW\"|" Cargo.toml
  [ "$(grep -c "github.com/nathanWolo/slinky\", rev = \"$NEW\"" Cargo.toml)" = 5 ] \
    || die "slinky: expected five slinky-* lines pinned by rev in Cargo.toml"
  cargo update -p slinky-search
  step "native tests (cargo test --release: bs_think against upstream's Agent, whole games in every mode)"
  # One at a time: time_budget_mode measures a 100 ms search and should have the machine to itself.
  cargo test --release -- --test-threads=1
  step "build slinky.wasm"
  bash build.sh
  # The opening only. The native build and the WebAssembly build get exp() and tanh() from
  # different C libraries, which round the last bit differently (measured: glibc, mingw and
  # wasi-libc all disagree on tanh), so far into a game a search can, rarely, go another way with
  # nothing wrong. A build that is wrong goes another way at once.
  step "the built file under Node against the native build: the first 30 turns of a game, move for move"
  local out; out="$(mktemp -d)"
  cargo run --release --example play -- "$weights" 0 4 12345 64 > "$out/native.txt"
  "${NODE:-node}" "$HERE/check_wasm.mjs" slinky-moves 0 4 12345 64 > "$out/wasm.txt"
  head -n 30 "$out/native.txt" > "$out/native-opening.txt"
  head -n 30 "$out/wasm.txt" > "$out/wasm-opening.txt"
  [ "$(wc -l < "$out/native-opening.txt")" -ge 10 ] || die "slinky: the native reference game is only $(wc -l < "$out/native.txt") lines long"
  cmp "$out/native-opening.txt" "$out/wasm-opening.txt" \
    || { diff "$out/native-opening.txt" "$out/wasm-opening.txt" | head -n 10; die "slinky: slinky.wasm does not open the game as the native build does (standard, 4 snakes, seed 12345, 64 simulations)"; }
  if cmp -s "$out/native.txt" "$out/wasm.txt"; then
    echo "identical for the whole game: $(($(wc -l < "$out/native.txt") - 1)) turns"
  else
    echo "identical for the first 30 turns; the two games part at turn $(($(cmp "$out/native.txt" "$out/wasm.txt" | sed 's/.*line //') - 1)) (see the comment above this step in update.sh)"
  fi
  step "play the built file under Node"
  "${NODE:-node}" "$HERE/check_wasm.mjs" slinky
}

# crossfish and poker name the commit in build.sh (PINNED=) and in README.md.
move_pin() {
  local new="${NEW:0:${#OLD}}"
  sed -i "s/^PINNED=$OLD/PINNED=$new/" build.sh
  sed -i "s/$OLD/$new/g" README.md
  [ "$(pinned)" = "$new" ] || die "$ENGINE: could not move PINNED in build.sh"
}

rebuild_crossfish() {
  cd "$HERE/crossfish"
  node_from_emscripten
  step "build crossfish.wasm"
  bash build.sh "$CHECKOUT" --any-commit
  step "upstream's cg_selfcheck fingerprint, native build against WebAssembly build"
  bash check.sh "$CHECKOUT"
  step "play the built file under Node"
  "$NODE" "$HERE/check_wasm.mjs" crossfish
  step "move the pin"
  move_pin
}

rebuild_poker() {
  cd "$HERE/poker"
  node_from_emscripten
  step "the Arcade's split game loop against upstream's Engine::run (check_split, native)"
  bash check.sh "$CHECKOUT"
  step "build poker.wasm"
  ALLOW_ANY_COMMIT=1 bash build.sh "$CHECKOUT"
  step "play the built file under Node (whole games: chips, legal and refused actions)"
  "$NODE" "$HERE/check_wasm.mjs" poker
  step "move the pin"
  move_pin
}

# ---------------------------------------------------------------- notes (the pull request text)
notes() {
  local from="$1" to short_from short_to
  to="$(upgit rev-parse HEAD)"; short_from="${from:0:7}"; short_to="${to:0:7}"
  echo "Rebuilds the Arcade's $TITLE engine from a newer commit of [$REPO](https://github.com/$REPO)."
  echo
  if [ "$short_from" = "$short_to" ]; then
    echo "Upstream is still at \`$short_to\`; this is a rebuild of the same sources (asked for by hand)."
  else
    echo "\`$short_from\` to \`$short_to\`: [compare on GitHub](https://github.com/$REPO/compare/$from...$to)"
  fi
  if [ "$short_from" != "$short_to" ] && upgit cat-file -e "$from^{commit}" 2>/dev/null; then
    echo
    echo "Upstream commits in between that touch what the build reads (\`${READS// /\`, \`}\`):"
    echo
    echo '```text'
    # shellcheck disable=SC2086
    upgit log --no-merges --format='%h %ad %s' --date=short "$from..$to" -- $READS | tr '`' "'" | head -n 60
    echo '```'
    local look="" changed
    # shellcheck disable=SC2086
    changed="$(upgit diff --name-only "$from" "$to")"
    has() { printf '%s\n' "$changed" | grep -qx "$1"; }
    case "$ENGINE" in
      tronzero) ! has engine/src/main.rs || look="- \`engine/src/main.rs\` changed upstream. It is not derived: \`src/api.rs\` sets the search up as \`main.rs\` did, and only \`C_PUCT\` and \`FPU_REDUCTION\` were checked to still match." ;;
      slinky)
        ! has native/crates/lambda/src/engine.rs || look="- \`native/crates/lambda/src/engine.rs\` changed upstream. \`Arcade::new\` and \`Arcade::think\` (\`_arcade/slinky/src/lib.rs\`) repeat its settings by hand."
        ! has deploy/lambda-native/deploy.sh || look="$look"$'\n'"- \`deploy/lambda-native/deploy.sh\` changed upstream. The Arcade's agent is set up as the deployed one was (see \`_arcade/slinky/README.md\`, \"How the agent is configured\")." ;;
      poker) ! has play/server.py || look="- \`play/server.py\` changed upstream. The state JSON in \`_arcade/poker/wasm_api.cpp\` is a port of it (README, \"Moving to a newer upstream commit\", step 3)." ;;
    esac
    if [ -n "$look" ]; then
      echo
      echo "**To look at by hand before merging** (no check covers these):"
      echo
      echo "${look#$'\n'}"
    fi
  fi
  echo
  echo "Passed before this pull request was opened:"
  echo
  case "$ENGINE" in
    tronzero)
      echo "- \`derive.py\` applied every one of its substitutions to the new sources, and \`C_PUCT\` and \`FPU_REDUCTION\` in \`src/lib.rs\` match upstream's \`main.rs\`"
      echo "- \`cargo test --release\`: whole 2- and 4-player games, natively"
      echo "- \`check_wasm.mjs tronzero\`: the built file, loaded by the page's own loader under Node, plays a 2-player and a 4-player game with every move checked" ;;
    slinky)
      echo "- \`cargo test --release\`: \`bs_think\` gives upstream's \`Agent\`'s move at every turn of four games, and whole games run in every mode, natively"
      echo "- the built file under Node plays the first 30 turns of a game move for move as the native build does (standard, 4 snakes, 64 simulations; the run's log says how far the two games stay together)"
      echo "- \`check_wasm.mjs slinky\`: the built file, loaded by the page's own loader, plays a game in each mode"
      echo
      echo "The weights in \`assets/wasm/slinky-weights/\` are not in the slinky repository and are unchanged." ;;
    crossfish)
      echo "- upstream's \`cg_selfcheck\` fingerprint (120 positions at depths 5, 7, 9 and 11) is identical between the native build and the WebAssembly build"
      echo "- \`check_wasm.mjs crossfish\`: the built file, loaded by the page's own loader under Node, plays two games against random legal moves with every move checked" ;;
    poker)
      echo "- \`check_split\`: 60 whole games (2, 3 and 4 players) are identical between upstream's \`Engine::run\` and the Arcade's split game loop, natively"
      echo "- \`check_wasm.mjs poker\`: the built file, loaded by the page's own loader under Node, plays whole games with the 4,800 chips counted at every step, offered actions accepted and all others refused" ;;
  esac
  echo
  local was now
  was="$(git -C "$ROOT" cat-file -s "HEAD:assets/wasm/$ENGINE.wasm" 2>/dev/null || echo "?")"
  now="$(wc -c < "$WASM" | tr -d ' ')"
  echo "\`assets/wasm/$ENGINE.wasm\`: $now bytes (was $was). Nothing here was tried in a browser: check out this branch and play a game before merging."
}

# ---------------------------------------------------------------- apply
# The workflow's build job runs code from the engine's repository and its dependencies, so what it
# hands over is not taken on trust: the patch is staged here, by a job that runs none of that code,
# and only if every path in it is the engine's own.
apply_update() {
  local dir="$1" new path
  [ -f "$dir/update.patch" ] && [ -f "$dir/upstream-commit" ] || die "$ENGINE: $dir holds no packaged update"
  new="$(head -n 1 "$dir/upstream-commit" | tr -d '\r')"
  case "$new" in
    *[!0-9a-f]*|"") die "$ENGINE: the packaged update names no upstream commit" ;;
  esac
  [ "${#new}" = 40 ] || die "$ENGINE: the packaged update names no upstream commit"
  cd "$ROOT"
  [ -z "$(git status --porcelain)" ] || die "$ENGINE: apply needs a clean checkout (git status shows changes)"
  refuse() { git reset --quiet --hard; die "$ENGINE: the packaged update was refused: $1"; }
  git apply --index "$dir/update.patch" || refuse "it does not apply to this checkout"
  while IFS= read -r -d '' path; do
    case "$path" in
      "_arcade/$ENGINE/"*|"assets/wasm/$ENGINE.wasm") ;;
      *) refuse "it changes $path, which is outside _arcade/$ENGINE/ and assets/wasm/$ENGINE.wasm" ;;
    esac
  done < <(git diff --cached --name-only --no-renames -z)
  ! git diff --cached --raw --no-renames | grep -Eq '^:[0-7]+ (120000|160000) '     || refuse "it adds a symbolic link or a submodule"
  git diff --cached --quiet && refuse "it changes nothing"
  echo "$new"
}

# ----------------------------------------------------------------
case "$CMD" in
  repo) echo "$REPO" ;;
  pinned) pinned ;;
  changed)
    need_checkout
    old="$(pinned)"
    # shellcheck disable=SC2086
    if ! upgit cat-file -e "$old^{commit}" 2>/dev/null; then echo changed   # the pinned commit is no longer upstream
    elif upgit diff --quiet "$old" HEAD -- $READS; then echo unchanged
    else echo changed; fi ;;
  rebuild)
    need_checkout
    OLD="$(pinned)"; NEW="$(upgit rev-parse HEAD)"
    PYTHON="${PYTHON:-python3}"
    trap finish EXIT
    "rebuild_$ENGINE"
    step "done"
    echo "$ENGINE: built from $REPO at $NEW (was $OLD), all checks passed"
    ls -l "$WASM" ;;
  notes)
    need_checkout
    [ -n "${4:-}" ] || die "notes: give the commit the pin moved from"
    notes "$4" ;;
  apply)
    [ -n "$CHECKOUT" ] && [ -d "$CHECKOUT" ] || die "apply: give the folder that holds the packaged update"
    apply_update "$(cd "$CHECKOUT" && pwd)" ;;
  *) die "unknown command '$CMD' (repo, pinned, changed, rebuild, notes, apply)" ;;
esac
