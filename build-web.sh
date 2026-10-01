#!/bin/sh
#
# build-web.sh - build the WebGL browser client.
#
#   ./build-web.sh                 build web/dist/ (needs only Node)
#   ./build-web.sh --wasm          force a core.wasm rebuild (needs the wasm toolchain)
#   ./build-web.sh --serve         Vite dev server with HMR
#   ./build-web.sh --test          typecheck + the offline test suites
#   ./build-web.sh --e2e           multiplayer test against a running server+bridge
#   ./build-web.sh --allow-stale   skip the staleness check
#
# web/wasm/core.wasm is committed, so the ordinary path needs no C toolchain at
# all. The toolchain is required only when the C sources it is built from change.
#
set -eu

ROOT=$(cd "$(dirname "$0")" && pwd)
cd "$ROOT"

WASM_OUT=web/wasm/core.wasm
HASH_OUT=web/wasm/core.hash

# Everything core.wasm is compiled from. If any of these change, the committed
# artifact is stale and must be rebuilt, or the browser would play by different
# rules than the C.
WASM_SRC="src/board.c src/board.h src/net_io.c src/net_io.h src/net_proto.h \
          web/core/core_api.c web/core/shim/openssl/ssl.h"

FORCE_WASM=0; SERVE=0; TEST=0; ALLOW_STALE=0; E2E=0
for arg in "$@"; do
  case "$arg" in
    --wasm)        FORCE_WASM=1 ;;
    --serve)       SERVE=1 ;;
    --test)        TEST=1 ;;
    --e2e)         E2E=1 ;;
    --allow-stale) ALLOW_STALE=1 ;;
    -h|--help)     sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)             echo "build-web.sh: unknown option '$arg'" >&2; exit 2 ;;
  esac
done

hash_sources() { cat $WASM_SRC | shasum -a 256 | cut -d' ' -f1; }

# ---------------------------------------------------------------- wasm toolchain
#
# Two supported layouts, preferred in this order:
#   1. Homebrew: clang from llvm, wasm-ld from lld, sysroot from wasi-libc,
#      compiler builtins from wasi-runtimes. ~79 MB, one `brew install`.
#   2. A monolithic wasi-sdk tarball at $WASI_SDK, /opt/wasi-sdk or ~/.wasi-sdk.
find_toolchain() {
  for d in ${WASI_SDK:-} /opt/wasi-sdk "$HOME/.wasi-sdk"; do
    if [ -n "$d" ] && [ -x "$d/bin/clang" ]; then
      TC_CC="$d/bin/clang"; TC_SYSROOT="$d/share/wasi-sysroot"; TC_RESDIR=""
      TC_LDPATH="$d/bin"; TC_KIND="wasi-sdk ($d)"; return 0
    fi
  done
  if command -v brew >/dev/null 2>&1; then
    _llvm=$(brew --prefix llvm 2>/dev/null || true)
    _lld=$(brew --prefix lld 2>/dev/null || true)
    _libc=$(brew --prefix wasi-libc 2>/dev/null || true)
    _rt=$(brew --prefix wasi-runtimes 2>/dev/null || true)
    if [ -x "${_llvm:-/nonexistent}/bin/clang" ] && [ -x "${_lld:-/nonexistent}/bin/wasm-ld" ] \
       && [ -d "${_libc:-/nonexistent}/share/wasi-sysroot" ]; then
      TC_CC="$_llvm/bin/clang"
      TC_SYSROOT="$_libc/share/wasi-sysroot"
      TC_RESDIR="$_rt/share/wasi-runtimes"
      TC_LDPATH="$_lld/bin"
      TC_KIND="homebrew llvm + lld + wasi-libc"
      return 0
    fi
  fi
  return 1
}

toolchain_hint() {
  cat >&2 <<'HINT'
No wasm toolchain found. Install one of:

  brew install llvm lld wasi-libc wasi-runtimes        # ~79 MB, recommended

  # or a monolithic wasi-sdk, then export WASI_SDK=/path/to/it
  curl -L https://github.com/WebAssembly/wasi-sdk/releases/latest \
    | tar xz -C /opt && mv /opt/wasi-sdk-* /opt/wasi-sdk
HINT
}

build_wasm() {
  find_toolchain || { toolchain_hint; exit 1; }
  echo "==> wasm: $TC_KIND"
  mkdir -p web/wasm
  set -- --target=wasm32-wasip1 "--sysroot=$TC_SYSROOT" -O2 -flto \
         -Wall -Wextra -Wno-unused-parameter \
         -I src -I web/core/shim \
         src/board.c src/net_io.c web/core/core_api.c \
         -nostartfiles -Wl,--no-entry -Wl,--lto-O2 -Wl,--strip-all \
         -Wl,--initial-memory=1048576 \
         -o "$WASM_OUT"
  [ -n "$TC_RESDIR" ] && set -- "-resource-dir=$TC_RESDIR" "$@"
  PATH="$TC_LDPATH:$PATH" "$TC_CC" "$@"
  hash_sources > "$HASH_OUT"
  echo "==> wasm: $WASM_OUT ($(wc -c < "$WASM_OUT" | tr -d ' ') bytes)"
}

check_stale() {
  [ "$ALLOW_STALE" = 1 ] && return 0
  if [ ! -f "$WASM_OUT" ] || [ ! -f "$HASH_OUT" ]; then
    echo "==> $WASM_OUT missing, building it"; build_wasm; return 0
  fi
  if [ "$(hash_sources)" != "$(cat "$HASH_OUT")" ]; then
    if find_toolchain; then
      echo "==> C sources changed, rebuilding wasm"; build_wasm; return 0
    fi
    cat >&2 <<EOF
ERROR: $WASM_OUT is stale.

The C sources it was built from have changed, and no wasm toolchain was found to
rebuild it. Shipping it anyway would mean the browser plays by different rules
than the C - which is exactly what compiling board.c to wasm exists to prevent.

EOF
    toolchain_hint
    echo "Or pass --allow-stale if you are certain the change does not matter." >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------- dispatch
# --wasm needs no Node at all, so it runs before any npm work.
if [ "$FORCE_WASM" = 1 ]; then build_wasm; exit 0; fi
check_stale

command -v npm >/dev/null 2>&1 || { echo "build-web.sh: npm not found" >&2; exit 1; }
[ -d web/node_modules ] || { echo "==> npm install"; npm --prefix web install --no-fund --no-audit; }

if [ "$E2E" = 1 ]; then
  # Needs asciisweeper-server and the bridge already running; see
  # web/bridge/README.md. Drives two clients through the real bridge into the
  # real server using the same wasm codec the browser uses.
  echo "==> multiplayer end-to-end"
  exec node web/test/mp.e2e.mjs
fi

if [ "$TEST" = 1 ]; then
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT
  echo "==> typecheck"
  (cd web && ./node_modules/.bin/tsc --noEmit)
  echo "==> wasm core tests"
  node web/test/core.test.mjs
  echo "==> render tests"
  # The draw code is plain TypeScript over a Surface, so it tests with no GPU and
  # no browser. esbuild is already a Vite dependency, so it bundles it for Node.
  (cd web && ./node_modules/.bin/esbuild test/render.test.ts --bundle --platform=node --format=esm --outfile="$TMP/render.mjs" --log-level=warning)
  node "$TMP/render.mjs"
  echo "==> shader math tests"
  (cd web && ./node_modules/.bin/esbuild test/shader.test.ts --bundle --platform=node --format=esm --outfile="$TMP/shader.mjs" --log-level=warning)
  node "$TMP/shader.mjs"
  exit 0
fi
if [ "$SERVE" = 1 ]; then
  echo "==> dev server"; exec npm --prefix web run dev
fi

echo "==> vite build"
npm --prefix web run build

# Post-build sanity: the built page must reference the hashed bundle RELATIVELY
# and must not still point at TypeScript. An absolute path breaks the moment
# dist/ is served from a subdirectory, and a .ts entry means the build did not
# actually replace the dev entry point.
entry=$(sed -n 's/.*<script type="module"[^>]*src="\([^"]*\)".*/\1/p' web/dist/index.html | head -1)
case "$entry" in
  ./assets/*.js) : ;;
  /*)  echo "build-web.sh: ERROR dist entry '$entry' is absolute; it must be relative" >&2; exit 1 ;;
  *.ts) echo "build-web.sh: ERROR dist still points at TypeScript ('$entry')" >&2; exit 1 ;;
  *)   echo "build-web.sh: ERROR unexpected dist entry '$entry'" >&2; exit 1 ;;
esac
echo
echo "==> web/dist is ready - copy it to a docroot:"
du -sh web/dist 2>/dev/null || true
find web/dist -type f | sed 's/^/    /'
