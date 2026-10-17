# AGENTS.md

This project builds a sandboxed dprint WebAssembly plugin for clang-format using
LLVM/Clang LibFormat.

## Project map

- `src/` contains the dprint Wasm plugin exports, LibFormat wrapper, fixed-heap
  allocator integration, and freestanding runtime shims.
- `cmake/` contains the top-level Wasm toolchain file and the LLVM LibFormat
  Wasm initial-cache file.
- `CMakeLists.txt` configures the `wasm32-unknown-unknown` plugin link and
  drives the nested LLVM native-tool and Wasm LibFormat builds.
- `scripts/` contains focused helper scripts that are still useful outside mise
  task bodies, plus the Deno release automation: `update.ts` (daily LLVM
  update), `ai_fix.ts` (Codex fixer and reviewer for updates),
  `publish_release.ts` (bumps the plugin version and tags a release), and
  `generateReleaseNotes.ts`.
- `tests/` contains Bats integration tests that exercise the plugin through
  dprint.
- `deployment/` contains the published `schema.json` (its `$id` keeps version
  `0.0.0`, which CI replaces on release) and the `@dprint/clang-format` npm
  package.
- `.github/workflows/*.ts` generate the `*.generated.yml` workflows with gagen.
  Never edit the YAML. Run `deno run -A <file>.ts` to regenerate, and
  `deno run -A <file>.ts --lint` to check it is in sync.
- `support/patches/` contains small LLVM patches for the freestanding Wasm
  build.
- `support/wasm-sysroot/` and `support/libcxx-wasm/` contain the minimal
  freestanding headers needed by the plugin build.

## Dev tool commands

- `mise install` installs the pinned host tools and hk hook.
- `mise deps llvm` downloads pinned LLVM source and applies patches; it also
  runs automatically before `mise run ...`.
- `mise run configure` configures the top-level CMake project.
- `mise run build` builds the LibFormat archive closure and plugin Wasm.
- `mise run test` builds, then tests `build/plugin.wasm`.
- `mise run hygiene` validates the mise tasks and checks formatting with dprint.

## Versions and releases

- The LLVM version is pinned by `llvm_version` in `scripts/fetch_llvm.sh`, and
  by the same version string in the other files listed in `scripts/update.ts`
  plus the `pixi.toml` ranges. `scripts/update.ts` bumps all of them.
- The plugin version is the `VERSION` in the `project()` call of
  `CMakeLists.txt`. Don't change it by hand; the `release` workflow and
  `scripts/update.ts` bump it with `scripts/publish_release.ts`, which also
  commits, tags, and pushes. A pushed tag makes CI create the GitHub release and
  `publish_npm` publish `@dprint/clang-format`.

## Project invariants

One maintainable zero-import Wasm dprint plugin: minimal repo source, explicit
LibFormat link closure, and as little support/shim code as possible. Wasm byte
size is secondary.

Strategies (maintainability-first):

- Build only the clang/LibFormat slice we need (explicit link closure, LLVM
  CMake trims).
- Patch LLVM in a small, reviewable way (`support/patches/`) to drop cold-path
  deps instead of growing POSIX stubs.
- Eliminate repo shims when upstream wasm guards or link GC make them
  unnecessary.

## Relevant Docs

- dprint: https://dprint.dev
- dprint plugins: https://dprint.dev/plugins/
- dprint Wasm plugin development:
  https://github.com/dprint/dprint/blob/main/docs/wasm-plugin-development.md
- dprint configuration: https://dprint.dev/config/
- Clang LibFormat: https://clang.llvm.org/docs/LibFormat.html
- LLVM getting started/building: https://llvm.org/docs/GettingStarted.html
- mise: https://mise.jdx.dev
- pixi: https://pixi.sh
