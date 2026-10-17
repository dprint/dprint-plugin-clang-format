// @ts-check
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
const wasmPath = path.join(__dirname, "../../build/plugin.wasm");
const targetPath = path.join(__dirname, "plugin.wasm");
fs.copyFileSync(wasmPath, targetPath);

if (args.length > 0) {
  // update the version based on the first argument
  const packageJsonPath = path.join(__dirname, "package.json");
  const packageJsonText = fs.readFileSync(packageJsonPath, "utf8");
  const packageJson = JSON.parse(packageJsonText);
  if (args[0] === "sync-version") {
    const cmakeListsPath = path.join(__dirname, "../../CMakeLists.txt");
    const cmakeListsText = fs.readFileSync(cmakeListsPath, "utf8");
    const versionMatch = cmakeListsText.match(
      /^project\(dprint_plugin_clang_format VERSION ([0-9.]+) /m,
    );
    if (!versionMatch) {
      throw new Error("Could not find the project version in CMakeLists.txt");
    }
    packageJson.version = versionMatch[1];
  } else {
    packageJson.version = args[0];
  }
  fs.writeFileSync(
    packageJsonPath,
    JSON.stringify(packageJson, undefined, 2) + "\n",
  );
}
