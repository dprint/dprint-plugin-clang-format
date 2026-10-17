cmake_minimum_required(VERSION 4.0)

project(dprint_plugin_clang_format LANGUAGES C CXX)

include(ExternalProject)

set(LLVM_SRC "${PROJECT_SOURCE_DIR}/third_party/llvm-project-23.1.3.src" CACHE PATH
    "Patched LLVM source directory")
set(LLVM_NATIVE_BUILD "${PROJECT_BINARY_DIR}/llvm-native" CACHE PATH
    "LLVM native tools build directory")
set(LLVM_WASM_BUILD "${PROJECT_BINARY_DIR}/llvm-wasm" CACHE PATH
    "LLVM wasm build directory")
set(PLUGIN_OUTPUT_DIR "${PROJECT_SOURCE_DIR}/build" CACHE PATH "Plugin output directory")
set(DPRINT_PLUGIN_VERSION "" CACHE STRING
    "Plugin version. Defaults to the release tag in GitHub Actions, or 0.0.0 locally.")
set(DPRINT_PLUGIN_SCHEMA_BASE_URL "https://plugins.dprint.dev/sargunv/dprint-clang-format"
    CACHE STRING "Base URL for published plugin schemas")

if(DPRINT_PLUGIN_VERSION STREQUAL "")
  if(DEFINED ENV{GITHUB_REF_NAME} AND "$ENV{GITHUB_REF_NAME}" MATCHES "^[0-9]+\\.[0-9]+\\.[0-9]+$")
    set(DPRINT_PLUGIN_VERSION "$ENV{GITHUB_REF_NAME}" CACHE STRING
        "Plugin version. Defaults to the release tag in GitHub Actions, or 0.0.0 locally." FORCE)
  else()
    set(DPRINT_PLUGIN_VERSION "0.0.0" CACHE STRING
        "Plugin version. Defaults to the release tag in GitHub Actions, or 0.0.0 locally." FORCE)
  endif()
endif()
message(STATUS "dprint plugin version: ${DPRINT_PLUGIN_VERSION}")

set(CMAKE_C_STANDARD 23)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
set(CMAKE_EXECUTABLE_SUFFIX ".wasm")

set(REQUIRED_LIBFORMAT_ARCHIVES
  "${LLVM_WASM_BUILD}/lib/libclangFormat.a"
  "${LLVM_WASM_BUILD}/lib/libclangToolingInclusions.a"
  "${LLVM_WASM_BUILD}/lib/libclangToolingCore.a"
  "${LLVM_WASM_BUILD}/lib/libclangRewrite.a"
  "${LLVM_WASM_BUILD}/lib/libclangLex.a"
  "${LLVM_WASM_BUILD}/lib/libclangBasic.a"
  "${LLVM_WASM_BUILD}/lib/libLLVMTargetParser.a"
  "${LLVM_WASM_BUILD}/lib/libLLVMSupport.a"
  "${LLVM_WASM_BUILD}/lib/libLLVMDemangle.a"
)

set(LIBCXX_SOURCES
  "${LLVM_SRC}/libcxx/src/chrono.cpp"
  "${LLVM_SRC}/libcxx/src/error_category.cpp"
  "${LLVM_SRC}/libcxx/src/functional.cpp"
  "${LLVM_SRC}/libcxx/src/hash.cpp"
  "${LLVM_SRC}/libcxx/src/memory.cpp"
  "${LLVM_SRC}/libcxx/src/new_helpers.cpp"
  "${LLVM_SRC}/libcxx/src/string.cpp"
  "${LLVM_SRC}/libcxx/src/system_error.cpp"
)

ExternalProject_Add(llvm_native_tools
  SOURCE_DIR "${LLVM_SRC}/llvm"
  BINARY_DIR "${LLVM_NATIVE_BUILD}"
  CMAKE_ARGS
    -G Ninja
    -DCMAKE_BUILD_TYPE=Release
    -DLLVM_ENABLE_PROJECTS=clang
    -DLLVM_TARGETS_TO_BUILD=
    -DLLVM_INCLUDE_TESTS=OFF
    -DLLVM_INCLUDE_BENCHMARKS=OFF
    -DLLVM_INCLUDE_EXAMPLES=OFF
    -DLLVM_ENABLE_BINDINGS=OFF
  BUILD_COMMAND "${CMAKE_COMMAND}" --build <BINARY_DIR> --target llvm-tblgen clang-tblgen
  INSTALL_COMMAND ""
  BUILD_BYPRODUCTS
    "${LLVM_NATIVE_BUILD}/bin/llvm-tblgen"
    "${LLVM_NATIVE_BUILD}/bin/clang-tblgen"
)

ExternalProject_Add(llvm_libformat
  SOURCE_DIR "${LLVM_SRC}/llvm"
  BINARY_DIR "${LLVM_WASM_BUILD}"
  DEPENDS llvm_native_tools
  CMAKE_ARGS
    -G Ninja
    -C "${PROJECT_SOURCE_DIR}/cmake/llvm-libformat-wasm-cache.cmake"
    -DLLVM_NATIVE_TOOL_DIR=${LLVM_NATIVE_BUILD}/bin
    -DLLVM_TABLEGEN=${LLVM_NATIVE_BUILD}/bin/llvm-tblgen
    -DCLANG_TABLEGEN=${LLVM_NATIVE_BUILD}/bin/clang-tblgen
  BUILD_COMMAND "${CMAKE_COMMAND}" --build <BINARY_DIR> --target clangFormat
  INSTALL_COMMAND ""
  BUILD_BYPRODUCTS ${REQUIRED_LIBFORMAT_ARCHIVES}
)

add_executable(plugin
  src/dprint_plugin.cpp
  src/wasm_allocator.c
  src/wasm_runtime_core.cpp
  ${LIBCXX_SOURCES}
)
add_dependencies(plugin llvm_libformat)

set_target_properties(plugin PROPERTIES
  OUTPUT_NAME "plugin"
  RUNTIME_OUTPUT_DIRECTORY "${PLUGIN_OUTPUT_DIR}"
)

target_compile_definitions(plugin PRIVATE
  CLANG_BUILD_STATIC=1
  DPRINT_PLUGIN_SCHEMA_BASE_URL="${DPRINT_PLUGIN_SCHEMA_BASE_URL}"
  DPRINT_PLUGIN_VERSION="${DPRINT_PLUGIN_VERSION}"
  _FILE_OFFSET_BITS=64
  _LARGEFILE_SOURCE
  __STDC_CONSTANT_MACROS
  __STDC_FORMAT_MACROS
  __STDC_LIMIT_MACROS
  _LIBCPP_DISABLE_EXTERN_TEMPLATE
)

target_compile_options(plugin PRIVATE
  -Os
  -ffreestanding
  -ffunction-sections
  -fdata-sections
  $<$<COMPILE_LANGUAGE:CXX>:-fno-exceptions>
  $<$<COMPILE_LANGUAGE:CXX>:-fno-rtti>
  $<$<COMPILE_LANGUAGE:CXX>:-fno-threadsafe-statics>
  $<$<COMPILE_LANGUAGE:CXX>:-fvisibility=hidden>
  $<$<COMPILE_LANGUAGE:CXX>:-nostdinc++>
)

target_compile_options(plugin PRIVATE
  $<$<AND:$<COMPILE_LANGUAGE:CXX>,$<COMPILE_LANG_AND_ID:CXX,Clang>>:-Wno-unused-command-line-argument>
)

target_include_directories(plugin SYSTEM PRIVATE
  "${PROJECT_SOURCE_DIR}/support/libcxx-wasm/include"
  "${LLVM_SRC}/libcxx/include"
  "${LLVM_SRC}/libcxx/src/include"
  "${PROJECT_SOURCE_DIR}/support/wasm-sysroot/include"
)

target_include_directories(plugin PRIVATE
  "${LLVM_SRC}/clang/include"
  "${LLVM_WASM_BUILD}/tools/clang/include"
  "${LLVM_WASM_BUILD}/include"
  "${LLVM_SRC}/llvm/include"
)

set_source_files_properties(${LIBCXX_SOURCES} PROPERTIES
  COMPILE_DEFINITIONS "_LIBCPP_BUILDING_LIBRARY"
)

set(DPRINT_PLUGIN_EXPORTS
  dprint_plugin_version_4
  get_shared_bytes_ptr
  clear_shared_bytes
  get_plugin_info
  get_license_text
  register_config
  release_config
  get_config_diagnostics
  get_resolved_config
  get_config_file_matching
  set_file_path
  set_override_config
  format
  format_range
  get_formatted_text
  get_error_text
  check_config_updates
)

set(PLUGIN_LINK_OPTIONS
  -nostdlib
  LINKER:--no-entry
  LINKER:--initial-memory=2162688
  LINKER:--export=malloc
  LINKER:--export=free
  LINKER:--export-memory
  LINKER:--gc-sections
)

foreach(export_name IN LISTS DPRINT_PLUGIN_EXPORTS)
  list(APPEND PLUGIN_LINK_OPTIONS "LINKER:--export=${export_name}")
endforeach()

target_link_options(plugin PRIVATE ${PLUGIN_LINK_OPTIONS})

# wasm-ld has no --start-group; two passes resolve circular refs between these archives.
target_link_libraries(plugin PRIVATE
  ${REQUIRED_LIBFORMAT_ARCHIVES}
  ${REQUIRED_LIBFORMAT_ARCHIVES}
)

find_program(WASM_VALIDATE_EXECUTABLE wasm-validate REQUIRED)
add_custom_command(TARGET plugin POST_BUILD
  COMMAND "${WASM_VALIDATE_EXECUTABLE}" "$<TARGET_FILE:plugin>"
  COMMAND "${CMAKE_COMMAND}" -E echo "built $<TARGET_FILE:plugin>"
  VERBATIM
)
