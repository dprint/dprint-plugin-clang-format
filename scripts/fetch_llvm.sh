#!/usr/bin/env bash
set -euo pipefail

llvm_version="23.1.3"
archive_name="llvm-project-${llvm_version}.src.tar.xz"
release_tag="llvmorg-${llvm_version}"
url="https://github.com/llvm/llvm-project/releases/download/${release_tag}/${archive_name}"

cache_dir="third_party/cache"
source_dir="third_party/llvm-project-${llvm_version}.src"
archive_path="${cache_dir}/${archive_name}"

mkdir -p "$cache_dir" third_party

if [[ ! -f "$archive_path" ]]; then
  curl --fail --location --retry 3 --output "$archive_path" "$url"
fi

if [[ ! -d "$source_dir" ]]; then
  tar -C third_party -xf "$archive_path"
fi

test -f "$source_dir/llvm/CMakeLists.txt"
test -f "$source_dir/clang/lib/Format/Format.cpp"

apply_patch() {
  local patch_file="$1"

  if patch -d "$source_dir" -p1 --forward --batch --dry-run --silent < "$patch_file" >/dev/null 2>&1; then
    patch -d "$source_dir" -p1 --forward --batch --silent < "$patch_file"
    echo "applied $(basename "$patch_file")"
  elif patch -d "$source_dir" -p1 --reverse --batch --dry-run --silent < "$patch_file" >/dev/null 2>&1; then
    echo "already applied: $(basename "$patch_file")"
  else
    echo "failed to apply $(basename "$patch_file")" >&2
    exit 1
  fi
}

for patch_file in support/patches/*.patch; do
  apply_patch "$patch_file"
done

echo "LLVM source ready: $source_dir"
