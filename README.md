# dprint-plugin-clang-format

[![npm version](https://img.shields.io/npm/v/@dprint/clang-format.svg)](https://www.npmjs.com/package/@dprint/clang-format)
[![CI](https://github.com/dprint/dprint-plugin-clang-format/workflows/CI/badge.svg)](https://github.com/dprint/dprint-plugin-clang-format/actions?query=workflow%3ACI)

Adapter for [clang-format](https://clang.llvm.org/docs/ClangFormat.html) for use
as a formatting plugin in [dprint](https://github.com/dprint/dprint). It formats
C, C++, and Objective-C.

## Install

[Install](https://dprint.dev/install/) and [setup](https://dprint.dev/setup/)
dprint.

Then in your project's directory with a dprint.json file, run:

```shellsession
dprint add clang-format
```

Note: You do not need clang-format installed globally as dprint will run
clang-format from the .wasm file in a sandboxed environment.

The plugin formats files with these extensions: `.c`, `.cc`, `.cpp`, `.cxx`,
`.h`, `.hh`, `.hpp`, `.hxx`, `.m`, `.mm`.

## Configuration

To add configuration, specify a `"clangFormat"` key in your dprint.json. It
takes
[clang-format style options](https://clang.llvm.org/docs/ClangFormatStyleOptions.html)
with their clang-format names, represented as JSON:

```jsonc
{
  "clangFormat": {
    "BasedOnStyle": "LLVM",
    "ColumnLimit": 100,
    "IndentWidth": 2,
    "SpaceBeforeParens": "Custom",
    "SpaceBeforeParensOptions": {
      "AfterControlStatements": false,
      "AfterFunctionDeclarationName": true,
      "AfterFunctionDefinitionName": true,
    },
  },
  "plugins": [
    // ...etc...
  ],
}
```

dprint global options are also mapped when the matching clang-format option is
not set explicitly:

| dprint option | clang-format option |
| ------------- | ------------------- |
| `lineWidth`   | `ColumnLimit`       |
| `indentWidth` | `IndentWidth`       |
| `useTabs`     | `UseTab`            |

`clangFormat` wins over the global option when both are present.

Note: The plugin does not understand clang-format's `.clang-format` files
because it runs sandboxed in a Wasm runtime—it has no access to the file system
in order to read them. For the same reason, `BasedOnStyle: "file"` and
`BasedOnStyle: "InheritParentConfig"` are rejected. Put the style in your dprint
configuration instead.

## Limitations

Files whose nested `#if`/`#ifdef`/`#elif` branches produce more than 16 branch
combinations may format differently from native clang-format in inactive or
platform-specific branches.

## How it works

The plugin links Clang LibFormat into a dprint plugin ABI v4 WebAssembly module.
It is built for `wasm32-unknown-unknown` with no Wasm imports.

We patch LLVM to disable code paths that do not make sense in a sandboxed dprint
plugin, such as real filesystem probing, process/environment helpers,
crash/signal handling, and other cold-path host facilities.

## Performance

The plugin appears to be about 30% faster than native clang-format. Try it
yourself with `mise run bench`.

```txt
Benchmarking stdin formatting over 250 LLVM/Clang source files.
Set BENCH_FILE_LIMIT=all for the full LLVM tree, or set BENCH_RUNS/BENCH_WARMUP to adjust rounds.
Benchmark 1: native clang-format
  Time (mean ± σ):      6.469 s ±  0.095 s    [User: 4.691 s, System: 1.502 s]
  Range (min … max):    6.385 s …  6.573 s    3 runs

Benchmark 2: dprint wasm plugin
  Time (mean ± σ):      4.969 s ±  0.094 s    [User: 2.986 s, System: 1.674 s]
  Range (min … max):    4.913 s …  5.078 s    3 runs

  Warning: Statistical outliers were detected. Consider re-running this benchmark on a quiet system without any interferences from other programs. It might help to use the '--warmup' or '--prepare' options.

Summary
  dprint wasm plugin ran
    1.30 ± 0.03 times faster than native clang-format
```

Tested on MacBook Pro 14" with an M5 Pro.

## Development

The build uses [mise](https://mise.jdx.dev) for the host tools and
[pixi](https://pixi.sh) for the conda-forge clang, lld, and clang-format. It
runs on Linux and macOS.

- `mise install` installs the pinned host tools.
- `mise run build` downloads and patches the pinned LLVM source, then builds
  `build/plugin.wasm`.
- `mise run test` builds, then runs the Bats tests in `tests/`, which compare
  the plugin's output with native clang-format.

## JS Formatting API

- [JS Formatter](https://github.com/dprint/js-formatter) - Browser/Deno and Node
- [npm package](https://www.npmjs.com/package/@dprint/clang-format)

## Versioning

This repo automatically upgrades to the latest version of clang-format (LLVM)
once a day. You can check which version of clang-format is being used by looking
at `llvm_version` in the scripts/fetch_llvm.sh file in this repo:

https://github.com/dprint/dprint-plugin-clang-format/blob/main/scripts/fetch_llvm.sh

The version of this plugin does not reflect the version of clang-format.
