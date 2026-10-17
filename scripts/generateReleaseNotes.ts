import { $, generateChangeLog, semver } from "automation";

const version = Deno.args[0];
// the change log is generated from the commits since the previous version, which the first release doesn't have
const changelog = await hasPastVersion()
  ? await generateChangeLog({
    versionTo: version,
  })
  : "Initial release.";
const text = `## Changes

${changelog}

## Install

[Install](https://dprint.dev/install/) and [setup](https://dprint.dev/setup/) dprint.

Then in your project's directory with a dprint.json file, run:

\`\`\`shellsession
dprint add clang-format
\`\`\`

## JS Formatting API

* [JS Formatter](https://github.com/dprint/js-formatter) - Browser/Deno and Node
* [npm package](https://www.npmjs.com/package/@dprint/clang-format)
`;

console.log(text);

async function hasPastVersion() {
  await $`git fetch origin --tags --recurse-submodules=no`.quiet();
  const newVersion = semver.parse(version);
  const tags = await $`git tag`.lines();
  return tags.some((tag) => {
    const tagVersion = semver.tryParse(tag);
    return tagVersion != null && semver.greaterThan(newVersion, tagVersion);
  });
}
