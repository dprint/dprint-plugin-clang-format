/**
 * This script checks for any clang-format (LLVM) updates and then
 * automatically publishes a new version of the plugin if so.
 */
import { $, semver } from "automation";
import { aiFixLlvmUpdate } from "./ai_fix.ts";
import { publishRelease } from "./publish_release.ts";

const rootDirPath = $.path(import.meta.dirname!).parentOrThrow();

// every file that pins the LLVM version by its exact version string. pixi.toml
// pins it as a version range, so it's updated separately.
const llvmVersionFiles = [
  ".github/actions/setup-ci-deps/action.yml",
  ".mise/tasks/bench",
  "CMakeLists.txt",
  "mise.toml",
  "scripts/fetch_llvm.sh",
  "tests/plugin.bats",
];
// conda-forge packages in pixi.toml that must match the LLVM version
const pixiLlvmPackages = ["clangxx", "lld", "clang-format"];

const currentVersion = getPinnedLlvmVersion();
$.logLight("Found LLVM version in scripts/fetch_llvm.sh:", currentVersion);

$.logStep("Getting latest LLVM version...");
const latestVersion = await getLatestLlvmVersion();
if (
  semver.greaterOrEqual(
    semver.parse(currentVersion),
    semver.parse(latestVersion),
  )
) {
  $.log("No new update found. Exiting.");
  Deno.exit(0);
}

$.log(`Found new version: ${latestVersion}`);
// the build uses the conda-forge clang, lld, and clang-format of the same LLVM
// version, which are usually published a few days after the LLVM release
if (!await isOnCondaForge(latestVersion)) {
  $.log("Not all conda-forge packages are published yet. Exiting.");
  Deno.exit(0);
}

$.logStep("Updating the LLVM version...");
const isPatchBump = isSameMinor(currentVersion, latestVersion);
await updateLlvmVersion(currentVersion, latestVersion);
await $`mise exec --no-deps -- pixi lock`.cwd(rootDirPath);

// Verify the update. A clean patch bump publishes exactly as before. A minor or
// major bump always gets an AI review (LLVM may have changed something the
// checks don't cover), and a patch bump that fails the checks gets an AI fix
// attempt.
$.logStep("Running checks (build + test + hygiene)...");
const checks = await runChecks();

if (!isPatchBump || !checks.passed) {
  if (checks.passed) {
    $.logStep("Minor LLVM update — running AI review...");
  } else {
    $.logStep("Update failed the checks — running AI fix...");
  }
  await aiFixLlvmUpdate({
    isPatchBump,
    fromVersion: currentVersion,
    toVersion: latestVersion,
    checksPassed: checks.passed,
    // hand the failing output to the AI so it can go straight to fixing
    // instead of re-running the checks just to rediscover the errors.
    checkOutput: checks.output,
  });

  // the AI must leave the project in a passing state, otherwise fail the
  // workflow (nothing gets published and the maintainer is notified).
  $.logStep("Re-running checks after AI changes...");
  await assertChecks();
}

if (Deno.args.includes("--skip-publish")) {
  Deno.exit(0);
}

$.logStep("Committing clang-format version bump commit...");
await $`git add .`;
const message = `${
  isPatchBump ? "fix" : "feat"
}: update to clang-format ${latestVersion}`;
await $`git commit -m ${message}`;

// release
await publishRelease(isPatchBump ? "patch" : "minor");

// the checks that must pass before publishing. `mise run test` configures and
// builds the plugin (fetching and patching the new LLVM source first) and then
// runs the Bats tests, which compare the plugin with the native clang-format.
// `inheritPiped` + `captureCombined` streams the output to the CI log live
// while also capturing it so a failure can be handed to the AI.
async function runChecks(): Promise<{ passed: boolean; output: string }> {
  const results = [];
  for (const command of checkCommands()) {
    results.push(await capture(command()));
  }
  const failures = results.filter((r) => r.code !== 0);
  return {
    passed: failures.length === 0,
    output: failures.map((r) => r.combined).join("\n\n"),
  };
}

function capture(command: ReturnType<typeof $>) {
  return command
    .stdout("inheritPiped")
    .stderr("inheritPiped")
    .captureCombined()
    .noThrow();
}

// same checks as `runChecks`, but throws on the first failure so the workflow
// aborts before anything is committed, tagged, or published.
async function assertChecks(): Promise<void> {
  for (const command of checkCommands()) {
    await command();
  }
}

// a function (not a top-level const) so it is hoisted -- `runChecks` is called
// from top-level code above before a const declared here would be initialized.
function checkCommands() {
  return [
    () => $`mise run test`.cwd(rootDirPath),
    () => $`mise run hygiene`.cwd(rootDirPath),
  ];
}

function getPinnedLlvmVersion(): string {
  const text = rootDirPath.join("scripts/fetch_llvm.sh").readTextSync();
  const match = text.match(/^llvm_version="([0-9]+\.[0-9]+\.[0-9]+)"$/m);
  if (match == null) {
    throw new Error("Could not find llvm_version in scripts/fetch_llvm.sh.");
  }
  return match[1];
}

async function getLatestLlvmVersion(): Promise<string> {
  const token = Deno.env.get("GITHUB_TOKEN");
  const releases: { tag_name: string; draft: boolean; prerelease: boolean }[] =
    await $.request(
      "https://api.github.com/repos/llvm/llvm-project/releases?per_page=100",
    )
      .header("accept", "application/vnd.github+json")
      .header(token ? { authorization: `Bearer ${token}` } : {})
      .json();
  const versions = releases
    .filter((r) => !r.draft && !r.prerelease)
    .map((r) => r.tag_name.match(/^llvmorg-([0-9]+\.[0-9]+\.[0-9]+)$/)?.[1])
    .filter((v) => v != null);
  versions.sort((a, b) => semver.compare(semver.parse(a), semver.parse(b)));
  const latest = versions.at(-1);
  if (latest == null) {
    throw new Error("Could not find an LLVM release.");
  }
  $.logLight("Latest LLVM release:", latest);
  return latest;
}

async function isOnCondaForge(version: string): Promise<boolean> {
  let allPublished = true;
  for (const name of pixiLlvmPackages) {
    const data: { versions: string[] } = await $.request(
      `https://api.anaconda.org/package/conda-forge/${name}`,
    ).json();
    const isPublished = data.versions.includes(version);
    $.logLight(
      `  ${name} ${version}: ${isPublished ? "published" : "missing"}`,
    );
    allPublished &&= isPublished;
  }
  return allPublished;
}

async function updateLlvmVersion(from: string, to: string) {
  for (const file of llvmVersionFiles) {
    const path = rootDirPath.join(file);
    const text = path.readTextSync();
    if (!text.includes(from)) {
      throw new Error(`Could not find LLVM version ${from} in ${file}.`);
    }
    path.writeTextSync(text.replaceAll(from, to));
  }

  const pixiTomlPath = rootDirPath.join("pixi.toml");
  let pixiToml = pixiTomlPath.readTextSync();
  const toVersion = semver.parse(to);
  const range = `>=${to},<${toVersion.major}.${toVersion.minor + 1}`;
  for (const name of pixiLlvmPackages) {
    const regex = new RegExp(`^${name} = "[^"]+"$`, "m");
    if (!regex.test(pixiToml)) {
      throw new Error(`Could not find ${name} in pixi.toml.`);
    }
    pixiToml = pixiToml.replace(regex, `${name} = "${range}"`);
  }
  pixiTomlPath.writeTextSync(pixiToml);

  // catch a new place pinning the version that isn't in `llvmVersionFiles`
  const remaining = await $`git grep -l -F ${from} -- . ${":!*.lock"}`
    .cwd(rootDirPath)
    .noThrow()
    .text();
  if (remaining.length > 0) {
    throw new Error(
      `LLVM version ${from} is still pinned in:\n${remaining}\nAdd these files to llvmVersionFiles in scripts/update.ts.`,
    );
  }
}

function isSameMinor(a: string, b: string) {
  const aVersion = semver.parse(a);
  const bVersion = semver.parse(b);
  return aVersion.major === bVersion.major && aVersion.minor === bVersion.minor;
}
