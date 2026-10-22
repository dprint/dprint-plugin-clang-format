setup_file() {
  bats_require_minimum_version 1.5.0
}

setup() {
  repo_root="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  cd "$repo_root"
  plugin_path="$repo_root/build/plugin.wasm"
}

format_file_with_dprint() {
  local config_path="$1"
  local source_path="$2"

  dprint fmt --stdin "$source_path" --config "$config_path" --config-discovery=false < "$source_path"
}

format_file_with_clang_format() {
  local style="$1"
  local source_path="$2"

  pixi run clang-format --style="$style" "$source_path"
}

write_config() {
  local config_path="$1"
  local body="$2"

  cat > "$config_path" <<JSON
{
  "plugins": ["$plugin_path"],
  $body
}
JSON
}

assert_matches_clang_format() {
  local source_path="$1"
  local style="$2"
  local config_body="$3"

  local expected
  local actual
  expected="$(format_file_with_clang_format "$style" "$source_path")"

  local config_path="$BATS_TEST_TMPDIR/dprint.json"
  write_config "$config_path" "$config_body"

  run --separate-stderr format_file_with_dprint "$config_path" "$source_path"

  if [ "$status" -ne 0 ]; then
    printf "%s\n" "$stderr"
  fi
  [ "$status" -eq 0 ]
  actual="$output"
  if [ "$actual" != "$expected" ]; then
    diff -u <(printf "%s" "$expected") <(printf "%s" "$actual")
  fi
  [ "$actual" = "$expected" ]
}

@test "plugin wasm has zero imports" {
  run pixi run wasm-objdump -x "$plugin_path"

  [ "$status" -eq 0 ]
  [[ "$output" != *"Import["* ]]
}

@test "plugin wasm uses small growable memory" {
  run pixi run wasm-objdump -x "$plugin_path"

  [ "$status" -eq 0 ]
  memory_section="$(printf "%s\n" "$output" | sed -n '/^Memory\[/,/^Global\[/p')"
  [[ "$memory_section" == *"pages: initial=33"* ]]
  [[ "$memory_section" != *" max="* ]]
}

@test "dprint CLI matches clang-format across representative LLVM and Clang sources" {
  local llvm_style='{BasedOnStyle: LLVM}'
  local llvm_config='"clangFormat": { "BasedOnStyle": "LLVM" }'
  local microsoft_style='{BasedOnStyle: Microsoft, ColumnLimit: 120, IndentWidth: 4}'
  local microsoft_config='
  "clangFormat": { "BasedOnStyle": "Microsoft", "ColumnLimit": 120, "IndentWidth": 4 }'

  assert_matches_clang_format \
    "third_party/llvm-project-23.1.4.src/libcxx/test/libcxx/algorithms/debug_less.pass.cpp" \
    "$llvm_style" \
    "$llvm_config"
  assert_matches_clang_format \
    "third_party/llvm-project-23.1.4.src/libcxx/test/libcxx/algorithms/alg.sorting/assert.sort.invalid_comparator/assert.sort.invalid_comparator.pass.cpp" \
    "$microsoft_style" \
    "$microsoft_config"
  assert_matches_clang_format \
    "third_party/llvm-project-23.1.4.src/llvm/include/llvm/ADT/SmallVector.h" \
    "$llvm_style" \
    "$llvm_config"
  assert_matches_clang_format \
    "third_party/llvm-project-23.1.4.src/llvm/lib/Support/CommandLine.cpp" \
    "$llvm_style" \
    "$llvm_config"
  assert_matches_clang_format \
    "third_party/llvm-project-23.1.4.src/clang/include/clang/Format/Format.h" \
    "$llvm_style" \
    "$llvm_config"
  assert_matches_clang_format \
    "third_party/llvm-project-23.1.4.src/clang/lib/Lex/Lexer.cpp" \
    "$microsoft_style" \
    "$microsoft_config"
  assert_matches_clang_format \
    "third_party/llvm-project-23.1.4.src/clang/test/CodeGenObjCXX/objc-struct-cxx-abi.mm" \
    "$llvm_style" \
    "$llvm_config"
}

@test "dprint CLI formats preprocessor-heavy C sources without trapping" {
  config_path="$BATS_TEST_TMPDIR/dprint.json"
  write_config "$config_path" '
  "clangFormat": { "BasedOnStyle": "LLVM" }'

  run --separate-stderr format_file_with_dprint \
    "$config_path" \
    "support/allocators/dlmalloc/malloc.c"

  if [ "$status" -ne 0 ]; then
    printf "%s\n" "$stderr"
  fi
  [ "$status" -eq 0 ]
  [[ "$output" == *"DLMALLOC_VERSION"* ]]
}

@test "dprint CLI resolves global options into clangFormat config" {
  config_path="$BATS_TEST_TMPDIR/dprint.json"
  write_config "$config_path" '
  "lineWidth": 20,
  "indentWidth": 3,
  "useTabs": false,
  "clangFormat": {}'

  run dprint output-resolved-config --config "$config_path" --config-discovery=false

  [ "$status" -eq 0 ]
  [[ "$output" == *'"ColumnLimit": 20'* ]]
  [[ "$output" == *'"IndentWidth": 3'* ]]
  [[ "$output" == *'"UseTab": "Never"'* ]]
}

@test "dprint CLI lets clangFormat config override globals" {
  config_path="$BATS_TEST_TMPDIR/dprint.json"
  write_config "$config_path" '
  "lineWidth": 20,
  "clangFormat": { "BasedOnStyle": "LLVM", "ColumnLimit": 80 }'

  run dprint output-resolved-config --config "$config_path" --config-discovery=false

  [ "$status" -eq 0 ]
  [[ "$output" == *'"ColumnLimit": 80'* ]]
}

@test "dprint CLI accepts nested clangFormat config" {
  assert_matches_clang_format \
    "third_party/llvm-project-23.1.4.src/libcxx/test/libcxx/algorithms/debug_less.pass.cpp" \
    '{BasedOnStyle: LLVM, SpaceBeforeParens: Custom, SpaceBeforeParensOptions: {AfterControlStatements: false, AfterFunctionDeclarationName: true, AfterFunctionDefinitionName: true}}' \
    '
  "clangFormat": {
    "BasedOnStyle": "LLVM",
    "SpaceBeforeParens": "Custom",
    "SpaceBeforeParensOptions": {
      "AfterControlStatements": false,
      "AfterFunctionDeclarationName": true,
      "AfterFunctionDefinitionName": true
    }
  }'
}

@test "dprint CLI rejects unsupported clangFormat options" {
  config_path="$BATS_TEST_TMPDIR/dprint.json"
  write_config "$config_path" '
  "clangFormat": { "NotAClangFormatOption": true }'

  run dprint output-resolved-config --config "$config_path" --config-discovery=false

  [ "$status" -eq 1 ]
  [[ "$output" == *"unsupported (clangFormat)"* ]]
}

@test "dprint CLI rejects filesystem-dependent style discovery" {
  config_path="$BATS_TEST_TMPDIR/dprint.json"
  write_config "$config_path" '
  "clangFormat": { "BasedOnStyle": "file" }'

  run dprint output-resolved-config --config "$config_path" --config-discovery=false

  [ "$status" -eq 1 ]
  [[ "$output" == *"Filesystem-dependent clang-format style discovery is not supported (BasedOnStyle)"* ]]
}
