/**
 * Bumps the plugin version, then commits, tags, and pushes it, which triggers
 * the release in CI.
 *
 * This repo has no Cargo.toml, so it can't use
 * `jsr:@dprint/automation/tasks/publish-release`. This does the same thing with
 * the version in the `project()` call of CMakeLists.txt instead.
 */
import { $, semver } from "automation";

export type ReleaseKind = "patch" | "minor";

const rootDirPath = $.path(import.meta.dirname!).parentOrThrow();
const cmakeListsPath = rootDirPath.join("CMakeLists.txt");
const projectVersionRegex =
  /^(project\(dprint_plugin_clang_format VERSION )([0-9]+\.[0-9]+\.[0-9]+)( )/m;

if (import.meta.main) {
  await publishRelease(getCliReleaseKind());
}

/** Bumps the plugin version, then commits, tags, and pushes it. */
export async function publishRelease(kind: ReleaseKind): Promise<string> {
  const newVersion = bumpPluginVersion(kind);

  $.logStep(`Committing ${newVersion} to git...`);
  await $`git add .`;
  await $`git commit -m ${newVersion}`;

  $.logStep("Pushing to main...");
  await $`git push -u origin HEAD`;

  $.logStep("Tagging...");
  await $`git tag ${newVersion}`;
  await $`git push origin ${newVersion}`;
  return newVersion;
}

/** Gets the plugin version from CMakeLists.txt. */
export function getPluginVersion(): string {
  const match = cmakeListsPath.readTextSync().match(projectVersionRegex);
  if (match == null) {
    throw new Error("Could not find the project version in CMakeLists.txt.");
  }
  return match[2];
}

function bumpPluginVersion(kind: ReleaseKind): string {
  const currentVersion = getPluginVersion();
  $.logLight(`Found plugin version: ${currentVersion}`);
  const newVersion = semver.format(
    semver.increment(semver.parse(currentVersion), kind),
  );
  $.logStep(`Setting plugin version to ${newVersion}...`);
  const text = cmakeListsPath.readTextSync();
  cmakeListsPath.writeTextSync(
    text.replace(projectVersionRegex, `$1${newVersion}$3`),
  );
  return newVersion;
}

function getCliReleaseKind(): ReleaseKind {
  if (Deno.args.length === 1 && Deno.args[0] === "--patch") {
    return "patch";
  } else if (Deno.args.length === 1 && Deno.args[0] === "--minor") {
    return "minor";
  } else {
    throw new Error(
      `Expected --patch or --minor, but got: ${Deno.args.join(" ")}`,
    );
  }
}
