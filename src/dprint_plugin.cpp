#include <time.h>

#include "clang/Format/Format.h"
#include "clang/Tooling/Core/Replacement.h"

#include "llvm/ADT/StringRef.h"
#include "llvm/Support/JSON.h"
#include "llvm/Support/raw_ostream.h"

#include <cstdlib>
#include <stdint.h>
#include <string>
#include <string_view>
#include <vector>

#ifndef DPRINT_PLUGIN_SCHEMA_BASE_URL
#error "DPRINT_PLUGIN_SCHEMA_BASE_URL must be defined by the build system"
#endif

#ifndef DPRINT_PLUGIN_VERSION
#error "DPRINT_PLUGIN_VERSION must be defined by the build system"
#endif

namespace {

struct ConfigDiagnostic {
  std::string property_name;
  std::string message;
};

constexpr const char *plugin_name = "dprint-plugin-clang-format";
constexpr const char *plugin_version = DPRINT_PLUGIN_VERSION;
constexpr const char *plugin_help_url =
    "https://dprint.dev/plugins/clang-format";
constexpr const char *plugin_update_url =
    "https://plugins.dprint.dev/dprint/dprint-plugin-clang-format/latest.json";
constexpr const char *plugin_file_extensions_json =
    "[\"c\",\"cc\",\"cpp\",\"cxx\",\"h\",\"hh\",\"hpp\",\"hxx\",\"m\",\"mm\"]";

constexpr const char *license_text =
    "Apache-2.0 WITH LLVM-exception\n"
    "\n"
    "See "
    "https://github.com/dprint/dprint-plugin-clang-format/blob/main/LICENSE\n";

struct RegisteredConfig {
  uint32_t id = 0;
  llvm::json::Object plugin;
  llvm::json::Object global;
  clang::format::FormatStyle style = clang::format::getLLVMStyle();
  std::string resolved_json = "{}";
  std::string diagnostics_json = "[]";
  bool valid = false;
};

std::vector<uint8_t> &shared_bytes() {
  static auto *value = new std::vector<uint8_t>();
  return *value;
}

std::vector<RegisteredConfig> &registered_configs() {
  static auto *value = new std::vector<RegisteredConfig>();
  return *value;
}

std::string &file_path() {
  static auto *value = new std::string();
  return *value;
}

std::string &override_config_json() {
  static auto *value = new std::string();
  return *value;
}

std::string &formatted_text() {
  static auto *value = new std::string();
  return *value;
}

std::string &error_text() {
  static auto *value = new std::string();
  return *value;
}

std::string take_shared_string() {
  auto &bytes = shared_bytes();
  std::string result(bytes.begin(), bytes.end());
  bytes.clear();
  return result;
}

uint32_t set_shared_string(std::string value) {
  auto &bytes = shared_bytes();
  bytes.assign(value.begin(), value.end());
  return static_cast<uint32_t>(bytes.size());
}

RegisteredConfig *find_config(uint32_t config_id) {
  for (auto &config : registered_configs()) {
    if (config.id == config_id) {
      return &config;
    }
  }
  return nullptr;
}

std::string json_escape(std::string_view text) {
  std::string out;
  out.reserve(text.size() + 8);
  for (char ch : text) {
    switch (ch) {
    case '\\':
      out += "\\\\";
      break;
    case '"':
      out += "\\\"";
      break;
    case '\n':
      out += "\\n";
      break;
    case '\r':
      out += "\\r";
      break;
    case '\t':
      out += "\\t";
      break;
    default:
      out += ch;
      break;
    }
  }
  return out;
}

std::string
diagnostics_to_json(const std::vector<ConfigDiagnostic> &diagnostics) {
  std::string out = "[";
  for (size_t i = 0; i < diagnostics.size(); ++i) {
    if (i != 0) {
      out += ',';
    }
    out += "{\"propertyName\":\"" + json_escape(diagnostics[i].property_name) +
           "\",\"message\":\"" + json_escape(diagnostics[i].message) + "\"}";
  }
  out += ']';
  return out;
}

std::string object_to_json(const llvm::json::Object &object) {
  llvm::json::Object copy = object;
  std::string out;
  llvm::raw_string_ostream stream(out);
  stream << llvm::json::Value(std::move(copy));
  stream.flush();
  return out;
}

std::string plugin_config_schema_url() {
  return std::string(DPRINT_PLUGIN_SCHEMA_BASE_URL) + "/" + plugin_version +
         "/schema.json";
}

std::string options_to_config_text(const llvm::json::Object &options,
                                   std::vector<ConfigDiagnostic> &diagnostics) {
  (void)diagnostics;
  llvm::json::Object copy = options;
  std::string out;
  llvm::raw_string_ostream stream(out);
  stream << llvm::json::Value(std::move(copy));
  stream.flush();
  return out;
}

bool parse_bool_value(const llvm::json::Value &value, bool &out) {
  if (auto boolean = value.getAsBoolean()) {
    out = *boolean;
    return true;
  }
  if (auto str = value.getAsString()) {
    if (*str == "true") {
      out = true;
      return true;
    }
    if (*str == "false") {
      out = false;
      return true;
    }
  }
  return false;
}

bool parse_number_value(const llvm::json::Value &value, double &out) {
  if (auto num = value.getAsNumber()) {
    out = *num;
    return true;
  }
  if (auto str = value.getAsString()) {
    const std::string text = str->str();
    char *end = nullptr;
    out = std::strtod(text.c_str(), &end);
    return end != text.c_str() && *end == '\0';
  }
  return false;
}

void merge_global_options(const llvm::json::Object &global,
                          llvm::json::Object &options,
                          std::vector<ConfigDiagnostic> &diagnostics) {
  auto take_number = [&](llvm::StringRef global_key,
                         llvm::StringRef clang_key) {
    auto it = global.find(global_key);
    if (it == global.end() || it->second.getAsNull() ||
        options.find(clang_key) != options.end()) {
      return;
    }
    double number = 0;
    if (!parse_number_value(it->second, number)) {
      diagnostics.push_back({global_key.str(), "Expected a number"});
      return;
    }
    options[clang_key] = static_cast<int64_t>(number);
  };

  take_number("lineWidth", "ColumnLimit");
  take_number("indentWidth", "IndentWidth");

  if (auto it = global.find("useTabs");
      it != global.end() && !it->second.getAsNull() &&
      options.find("UseTab") == options.end()) {
    bool use_tabs = false;
    if (!parse_bool_value(it->second, use_tabs)) {
      diagnostics.push_back({"useTabs", "Expected a boolean"});
    } else {
      options["UseTab"] =
          use_tabs ? llvm::json::Value("Always") : llvm::json::Value("Never");
    }
  }

  (void)global.find("newLineKind");
}

void merge_object_options(const llvm::json::Object &source,
                          llvm::json::Object &options,
                          std::vector<ConfigDiagnostic> &diagnostics) {
  (void)diagnostics;
  for (const auto &entry : source) {
    options[entry.first] = entry.second;
  }
}

void reject_filesystem_dependent_style(
    const llvm::json::Object &options,
    std::vector<ConfigDiagnostic> &diagnostics) {
  auto it = options.find("BasedOnStyle");
  if (it == options.end()) {
    return;
  }
  auto value = it->second.getAsString();
  if (!value) {
    return;
  }
  if (value->equals_insensitive("file") ||
      value->equals_insensitive("InheritParentConfig")) {
    diagnostics.push_back(
        {"BasedOnStyle",
         "Filesystem-dependent clang-format style discovery is not supported"});
  }
}

struct ResolveResult {
  clang::format::FormatStyle style;
  llvm::json::Object resolved;
  std::vector<ConfigDiagnostic> diagnostics;
  bool valid = false;
};

ResolveResult resolve_format_style(const llvm::json::Object &plugin,
                                   const llvm::json::Object &global,
                                   const llvm::json::Object *override_options) {
  ResolveResult result;
  result.style =
      clang::format::getLLVMStyle(clang::format::FormatStyle::LK_Cpp);

  llvm::json::Object options;
  merge_object_options(plugin, options, result.diagnostics);

  if (override_options != nullptr) {
    merge_object_options(*override_options, options, result.diagnostics);
  }

  merge_global_options(global, options, result.diagnostics);
  reject_filesystem_dependent_style(options, result.diagnostics);

  result.resolved = options;

  if (options.empty()) {
    result.valid = true;
    return result;
  }

  const std::string config_text =
      options_to_config_text(options, result.diagnostics);
  if (!result.diagnostics.empty()) {
    return result;
  }

  const std::error_code ec =
      clang::format::parseConfiguration(config_text, &result.style);
  if (ec) {
    result.diagnostics.push_back({"clangFormat", ec.message()});
    return result;
  }

  result.valid = true;
  return result;
}

RegisteredConfig resolve_registered_config(uint32_t config_id,
                                           const llvm::json::Object &plugin,
                                           const llvm::json::Object &global) {
  RegisteredConfig entry;
  entry.id = config_id;
  entry.plugin = plugin;
  entry.global = global;

  ResolveResult resolved = resolve_format_style(plugin, global, nullptr);
  entry.style = resolved.style;
  entry.valid = resolved.valid;
  entry.resolved_json = object_to_json(resolved.resolved);
  entry.diagnostics_json = diagnostics_to_json(resolved.diagnostics);
  return entry;
}

void upsert_config(uint32_t config_id, RegisteredConfig entry) {
  if (auto *config = find_config(config_id)) {
    *config = std::move(entry);
    return;
  }
  registered_configs().push_back(std::move(entry));
}

bool parse_register_payload(std::string_view json, llvm::json::Object &plugin,
                            llvm::json::Object &global,
                            std::vector<ConfigDiagnostic> &diagnostics) {
  llvm::Expected<llvm::json::Value> parsed = llvm::json::parse(json);
  if (!parsed) {
    diagnostics.push_back({"clangFormat", llvm::toString(parsed.takeError())});
    return false;
  }

  const llvm::json::Object *root = parsed->getAsObject();
  if (root == nullptr) {
    diagnostics.push_back({"clangFormat", "Expected a config object"});
    return false;
  }

  if (const llvm::json::Object *plugin_object = root->getObject("plugin")) {
    plugin = *plugin_object;
  } else {
    diagnostics.push_back({"plugin", "Missing plugin config object"});
  }

  if (const llvm::json::Object *global_object = root->getObject("global")) {
    global = *global_object;
  }

  return true;
}

bool parse_override_payload(std::string_view json,
                            llvm::json::Object &override_options,
                            std::vector<ConfigDiagnostic> &diagnostics) {
  if (json.empty()) {
    return true;
  }

  llvm::Expected<llvm::json::Value> parsed = llvm::json::parse(json);
  if (!parsed) {
    diagnostics.push_back(
        {"overrideConfig", llvm::toString(parsed.takeError())});
    return false;
  }

  const llvm::json::Object *root = parsed->getAsObject();
  if (root == nullptr) {
    diagnostics.push_back({"overrideConfig", "Expected an object"});
    return false;
  }

  override_options = *root;
  return true;
}

void normalize_file_path() {
  for (auto &ch : file_path()) {
    if (ch == '\\') {
      ch = '/';
    }
  }
}

clang::format::FormatStyle style_for_format(const RegisteredConfig &entry,
                                            std::string_view code) {
  std::vector<ConfigDiagnostic> diagnostics;
  llvm::json::Object override_options;
  const llvm::json::Object *override_ptr = nullptr;

  if (!override_config_json().empty()) {
    if (parse_override_payload(override_config_json(), override_options,
                               diagnostics)) {
      override_ptr = &override_options;
    }
  }

  ResolveResult resolved =
      resolve_format_style(entry.plugin, entry.global, override_ptr);
  if (!resolved.valid) {
    return entry.style;
  }

  clang::format::FormatStyle style = resolved.style;
  if (!file_path().empty()) {
    style.Language = clang::format::guessLanguage(file_path(), code);
  }
  return style;
}

uint32_t format_inner(uint32_t config_id, uint32_t range_start,
                      uint32_t range_end, bool has_range) {
  std::string input = take_shared_string();
  formatted_text().clear();
  error_text().clear();

  if (!has_range) {
    range_start = 0;
    range_end = static_cast<uint32_t>(input.size());
  }

  if (range_start > range_end || range_end > input.size()) {
    override_config_json().clear();
    error_text() = "invalid format range";
    return 2;
  }

  RegisteredConfig *entry = find_config(config_id);
  if (entry == nullptr) {
    override_config_json().clear();
    error_text() = "unknown config id";
    return 2;
  }

  clang::format::FormatStyle style = style_for_format(*entry, input);
  override_config_json().clear();

  llvm::StringRef format_file_name = file_path().empty()
                                         ? llvm::StringRef("<stdin>")
                                         : llvm::StringRef(file_path());
  std::vector<clang::tooling::Range> ranges = {
      clang::tooling::Range(range_start, range_end - range_start)};

  auto replacements =
      clang::format::sortIncludes(style, input, ranges, format_file_name);
  auto changed_input =
      clang::tooling::applyAllReplacements(input, replacements);
  if (!changed_input) {
    error_text() = "clang-format failed to apply replacements";
    return 2;
  }

  ranges =
      clang::tooling::calculateRangesAfterReplacements(replacements, ranges);
  auto format_replacements =
      clang::format::reformat(style, *changed_input, ranges, format_file_name);
  replacements = replacements.merge(format_replacements);

  auto result = clang::tooling::applyAllReplacements(input, replacements);
  if (!result) {
    error_text() = "clang-format failed to apply replacements";
    return 2;
  }
  if (*result == input) {
    return 0;
  }
  formatted_text() = std::move(*result);
  return 1;
}

} // namespace

extern "C" {

uint32_t dprint_plugin_version_4() { return 4; }

const uint8_t *get_shared_bytes_ptr() {
  auto &bytes = shared_bytes();
  return bytes.empty() ? nullptr : bytes.data();
}

uint8_t *clear_shared_bytes(uint32_t size) {
  auto &bytes = shared_bytes();
  bytes.assign(size, 0);
  return bytes.empty() ? nullptr : bytes.data();
}

uint32_t get_plugin_info() {
  return set_shared_string(
      std::string("{\"name\":\"") + plugin_name + "\",\"version\":\"" +
      plugin_version + "\",\"configKey\":\"clangFormat\",\"fileExtensions\":" +
      plugin_file_extensions_json + ",\"helpUrl\":\"" + plugin_help_url +
      "\",\"configSchemaUrl\":\"" + plugin_config_schema_url() +
      "\",\"updateUrl\":\"" + plugin_update_url +
      "\",\"supportsRangeFormatting\":true}");
}

uint32_t get_license_text() { return set_shared_string(license_text); }

void register_config(uint32_t config_id) {
  llvm::json::Object plugin;
  llvm::json::Object global;
  std::vector<ConfigDiagnostic> diagnostics;
  const std::string payload = take_shared_string();

  if (!parse_register_payload(payload, plugin, global, diagnostics)) {
    RegisteredConfig entry;
    entry.id = config_id;
    entry.valid = false;
    entry.diagnostics_json = diagnostics_to_json(diagnostics);
    upsert_config(config_id, std::move(entry));
    return;
  }

  upsert_config(config_id,
                resolve_registered_config(config_id, plugin, global));
}

void release_config(uint32_t config_id) {
  auto &configs = registered_configs();
  for (auto it = configs.begin(); it != configs.end(); ++it) {
    if (it->id == config_id) {
      configs.erase(it);
      return;
    }
  }
}

uint32_t get_config_diagnostics(uint32_t config_id) {
  if (const RegisteredConfig *entry = find_config(config_id)) {
    return set_shared_string(entry->diagnostics_json);
  }
  return set_shared_string("[]");
}

uint32_t get_resolved_config(uint32_t config_id) {
  if (const RegisteredConfig *entry = find_config(config_id)) {
    return set_shared_string(entry->resolved_json);
  }
  return set_shared_string("{}");
}

uint32_t get_config_file_matching(uint32_t) {
  return set_shared_string(std::string("{\"fileExtensions\":") +
                           plugin_file_extensions_json + ",\"fileNames\":[]}");
}

void set_file_path() {
  file_path() = take_shared_string();
  normalize_file_path();
}

void set_override_config() { override_config_json() = take_shared_string(); }

uint32_t format(uint32_t config_id) {
  return format_inner(config_id, 0, 0, false);
}

uint32_t format_range(uint32_t config_id, uint32_t range_start,
                      uint32_t range_end) {
  return format_inner(config_id, range_start, range_end, true);
}

uint32_t get_formatted_text() {
  auto &text = formatted_text();
  return set_shared_string(std::move(text));
}

uint32_t get_error_text() {
  auto &text = error_text();
  return set_shared_string(std::move(text));
}

uint32_t check_config_updates() {
  return set_shared_string("{\"kind\":\"ok\",\"data\":[]}");
}

} // extern "C"
