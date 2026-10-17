/**
 * Reconciles this plugin with a new LLVM (clang-format) release using OpenAI
 * Codex, in two stages that each run Codex in a session of its own:
 *
 *   1. a Codex agentic session edits the repo and runs the checks until they
 *      pass (rebasing the LLVM patches, fixing the freestanding Wasm build,
 *      and/or adapting the plugin to LibFormat API changes), then
 *   2. a SEPARATE reviewer session reviews the result with Codex, so it can
 *      investigate (read the upstream LLVM source, grep the repo). It is
 *      instructed to review only and not modify anything. If it finds blocking
 *      issues they are fed back to the stage-1 Codex for another pass, bounded
 *      by `REVIEW_MAX_ROUNDS`. If it still isn't approved, this throws so the
 *      workflow fails and nothing is published.
 *
 * Two situations call this:
 *   - a patch bump that failed the checks (fix the breakage), and
 *   - any minor or major bump (review the update even when it still builds).
 *
 * Both stages use the default model of the Codex CLI, which is installed at
 * its latest version when it is missing, so they move to a new model when
 * Codex does. Set `CODEX_MODEL` or `REVIEW_MODEL` to pin the model of a stage.
 *
 * Codex must NOT commit or push -- `update.ts` captures the working tree
 * changes into the clang-format bump commit afterwards.
 */
import { $ } from "automation";

export interface AiFixOptions {
  /** true for a patch bump, false for a minor/major bump. */
  isPatchBump: boolean;
  /** LLVM version currently in scripts/fetch_llvm.sh (before the bump). */
  fromVersion: string;
  /** LLVM version being upgraded to. */
  toVersion: string;
  /** Whether the checks (`mise run test` + `mise run hygiene`) already passed. */
  checksPassed: boolean;
  /** Combined output of the failing checks (empty when `checksPassed`). */
  checkOutput: string;
}

/** Max number of times the reviewer may send changes back to Codex. */
const REVIEW_MAX_ROUNDS = 2;

export async function aiFixLlvmUpdate(options: AiFixOptions): Promise<void> {
  const apiKey = requireApiKey();
  await ensureCodexInstalled();
  await codexLogin(apiKey);

  // stage 1: let Codex reconcile the update.
  await runCodex(buildFixPrompt(options));

  // stage 2: independent second-model review, with a bounded refix loop.
  for (let round = 1;; round++) {
    const review = await reviewChanges(options);
    logReview(review);
    if (review.approved) {
      return;
    }
    if (round > REVIEW_MAX_ROUNDS) {
      const blocking = review.issues.filter((i) => i.severity === "blocking");
      throw new Error(
        `AI reviewer did not approve after ${REVIEW_MAX_ROUNDS} refix round(s). Blocking issues:\n`
          + blocking.map((i) => `  - ${i.description}`).join("\n"),
      );
    }
    $.logStep(`Reviewer requested changes — Codex refix round ${round}...`);
    await runCodex(buildRefixPrompt(review, options));
  }
}

// stage 1: Codex ---------------------------------------------------------------

async function runCodex(prompt: string): Promise<void> {
  const args = [
    "exec",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
  ];
  const model = Deno.env.get("CODEX_MODEL");
  if (model) {
    args.push("--model", model);
  }
  args.push(prompt);

  $.logStep("Running Codex...");
  await $`codex ${args}`;
}

function buildFixPrompt(options: AiFixOptions): string {
  const { isPatchBump, fromVersion, toVersion, checksPassed, checkOutput } =
    options;

  const situation = checksPassed
    ? `LLVM was upgraded from ${fromVersion} to ${toVersion} (a ${
      isPatchBump ? "patch" : "minor or major"
    } bump). The project already builds and the checks pass, but the new LLVM version may have changed things the checks don't catch: LibFormat options this plugin relies on, new host dependencies that the LLVM patches should trim instead of shims, or patches and workarounds that are no longer needed.`
    : `LLVM was upgraded from ${fromVersion} to ${toVersion} and the checks fail. This is usually because an LLVM patch in \`support/patches/\` no longer applies, because the freestanding Wasm build of LibFormat hits a new host dependency (a missing header, declaration, or undefined symbol), or because a LibFormat API used by \`src/dprint_plugin.cpp\` changed.`;

  const failureOutput = checkOutput.trim().length > 0
    ? [
      ``,
      `The checks currently fail with the output below. Use it as your starting point instead of re-running the checks just to rediscover the errors:`,
      "```",
      truncateHead(checkOutput.trim()),
      "```",
    ]
    : [];

  return [
    `You are updating "dprint-plugin-clang-format", a C++ dprint Wasm plugin that links LLVM/Clang LibFormat (clang-format) into a zero-import \`wasm32-unknown-unknown\` module to format C, C++, and Objective-C.`,
    ``,
    situation,
    ...failureOutput,
    ``,
    `Your goal: make the checks pass while keeping the repo's invariants: one maintainable zero-import Wasm plugin, an explicit LibFormat link closure, and as little support/shim code as possible. Do NOT commit or push; only edit files in the working tree.`,
    ``,
    describeWiring(toVersion),
    ``,
    `To see exactly what changed in LLVM, compare the pristine sources of both versions. Download the previous release with \`curl -fL -o /tmp/old.tar.xz https://github.com/llvm/llvm-project/releases/download/llvmorg-${fromVersion}/llvm-project-${fromVersion}.src.tar.xz\` and extract it outside the repo. The new release tarball is already at \`third_party/cache/llvm-project-${toVersion}.src.tar.xz\`.`,
    ``,
    `Rules:`,
    `1. When a patch no longer applies, rebase the failing hunks onto the new upstream code so that they do the same thing as before. Keep each patch focused on the theme in its file name. Do not delete a patch unless upstream made it unnecessary.`,
    `2. When the freestanding build hits a new host dependency, prefer trimming the cold path with a small \`#if defined(__wasm__)\` guard in a patch over adding stubs to \`src/wasm_runtime_core.cpp\`. Only add declarations or macros to \`support/wasm-sysroot/include/\` or \`support/libcxx-wasm/include/\` when code that must compile needs them, and never add implementations of host facilities there.`,
    `3. The Wasm module must keep having zero imports, so any new undefined symbol at link time must be removed (with a patch guard) rather than imported or stubbed with a fake implementation.`,
    `4. Do NOT change the tests to make them pass. The Bats tests compare the plugin with the native clang-format of the same version, so formatting changes in the new LibFormat are expected and need no test change. If a test refers to an LLVM source file that no longer exists upstream, replace it with a similar file.`,
    `5. Do NOT edit README.md. Its documentation is maintained separately, so leave it untouched.`,
    `6. Preserve the existing code style. New comments start lowercase unless multiple sentences.`,
    `7. When done, ALL of these must pass — iterate until they are all clean:`,
    `     mise run test`,
    `     mise run hygiene`,
    `   \`mise run test\` re-fetches and re-patches the LLVM source when \`support/patches/\` or \`scripts/fetch_llvm.sh\` changed, configures the build with \`cmake --fresh\`, builds \`build/plugin.wasm\`, and runs the Bats tests in \`tests/\`. \`mise run hygiene\` validates the mise tasks and checks formatting with dprint. Run \`dprint fmt\` to fix formatting.`,
    `8. Do not change the plugin's own version in the \`project()\` call of CMakeLists.txt, do not change the LLVM version, do not run git commit, and do not push.`,
  ].join("\n");
}

function buildRefixPrompt(review: ReviewResult, options: AiFixOptions): string {
  return [
    `An independent reviewer examined your changes to dprint-plugin-clang-format and found issues that must be fixed. Address every blocking issue below, keeping \`mise run test\` and \`mise run hygiene\` passing. Do not commit or push.`,
    ``,
    `Reviewer summary: ${review.summary}`,
    ``,
    `Issues:`,
    ...review.issues.map((i) => `  - [${i.severity}] ${i.description}`),
    ``,
    describeWiring(options.toVersion),
  ].join("\n");
}

function describeWiring(toVersion: string): string {
  return [
    `How the repo is wired (keep all of these consistent with each other):`,
    `- \`scripts/fetch_llvm.sh\` -> downloads the LLVM source release pinned by \`llvm_version\` into \`third_party/cache/\`, extracts it to \`third_party/llvm-project-${toVersion}.src\`, and applies every \`support/patches/*.patch\` with \`patch -p1 --forward\` (a patch that is already applied is skipped). After editing a patch that was already applied, delete \`third_party/llvm-project-${toVersion}.src\` (keep \`third_party/cache\`) and re-run \`scripts/fetch_llvm.sh\` to start from pristine source.`,
    `- \`support/patches/*.patch\` -> small LLVM patches that guard cold-path host facilities (real filesystem access, process and environment helpers, signals and crash recovery, the current date and time, mmap, dynamic libraries, sockets) with \`#if defined(__wasm__)\` so the freestanding build needs no POSIX implementations. \`dprint-wasm-limit-format-pp-branches.patch\` limits how many preprocessor branch combinations LibFormat's UnwrappedLineParser formats, and \`dprint-wasm-skip-frontend-openmp.patch\` skips a CMake dependency. Keep their format: plain unified diffs with \`--- a/<path>\` and \`+++ b/<path>\` headers relative to the llvm-project root and no \`diff --git\` or \`index\` lines, as produced by \`diff -u --label a/<path> --label b/<path> <old> <new>\`, with the files of a patch in sorted order.`,
    `- \`cmake/llvm-libformat-wasm-cache.cmake\` -> initial cache for the nested LLVM configure that builds LibFormat for wasm32 (compiler flags, sysroot include paths, and the LLVM CMake options that trim the build).`,
    `- \`CMakeLists.txt\` -> builds the native \`llvm-tblgen\`/\`clang-tblgen\` and then the Wasm \`clangFormat\` target as ExternalProjects, and links \`build/plugin.wasm\`. \`REQUIRED_LIBFORMAT_ARCHIVES\` is the explicit LibFormat link closure (add an archive here if \`clangFormat\` gains a library dependency), \`LIBCXX_SOURCES\` are the libc++ sources compiled into the plugin, \`DPRINT_PLUGIN_EXPORTS\` are the dprint plugin ABI v4 exports, and \`--initial-memory\` sets the initial memory that a Bats test checks.`,
    `- \`support/wasm-sysroot/include/\` and \`support/libcxx-wasm/include/\` -> the minimal freestanding C headers and libc++ overrides (including \`__config_site\`) the build compiles against.`,
    `- \`src/wasm_runtime_core.cpp\` and \`src/wasm_allocator.c\` -> the freestanding runtime shims and the dlmalloc-based allocator.`,
    `- \`src/dprint_plugin.cpp\` -> the dprint Wasm plugin ABI v4 exports. The \`clangFormat\` config object is serialized to JSON (which is valid YAML) and passed as is to \`clang::format::parseConfiguration\` on top of \`getLLVMStyle(LK_Cpp)\`, so there is no per-option mapping: new \`FormatStyle\` options work without code changes, and unknown or invalid options are reported by \`parseConfiguration\`. \`merge_global_options\` maps dprint's global \`lineWidth\`, \`indentWidth\`, and \`useTabs\` onto \`ColumnLimit\`, \`IndentWidth\`, and \`UseTab\` (\`Always\`/\`Never\`) when they are not set in \`clangFormat\`, and \`reject_filesystem_dependent_style\` rejects \`BasedOnStyle: file\` and \`InheritParentConfig\`. Formatting runs \`sortIncludes\` and then \`reformat\`, with the language from \`guessLanguage\`.`,
    `- \`deployment/schema.json\` -> the JSON schema of the \`clangFormat\` config object. It only describes \`BasedOnStyle\` and allows any other clang-format option.`,
    `- \`tests/plugin.bats\` -> Bats integration tests that format files through the dprint CLI with \`build/plugin.wasm\` and compare the output with the native \`clang-format\` from pixi, using LLVM source files from \`third_party/llvm-project-${toVersion}.src\` as inputs.`,
    `- \`pixi.toml\`/\`pixi.lock\` -> the conda-forge \`clangxx\`, \`lld\`, and \`clang-format\` of the same LLVM version, used to compile the plugin and as the native oracle in the tests. \`mise.toml\` pins the other tools and defines the tasks.`,
  ].join("\n");
}

// keep the tail of long check output -- the errors and the build summary are
// at the end, which is the most useful part for the AI.
function truncateHead(text: string, max = 20_000): string {
  return text.length > max
    ? `... (truncated)\n${text.slice(text.length - max)}`
    : text;
}

// stage 2: independent reviewer ------------------------------------------------

interface ReviewResult {
  approved: boolean;
  summary: string;
  issues: ReviewIssue[];
}

interface ReviewIssue {
  severity: "blocking" | "nit";
  description: string;
}

// The reviewer runs Codex too so it can actually investigate (read the LLVM
// source, grep the repo, verify the patches against upstream). Its verdict is
// captured as JSON via --output-last-message.
//
// NOTE: we deliberately do NOT use `--sandbox read-only` here. That makes Codex
// wrap commands in bubblewrap, which cannot set up its network namespace on the
// GitHub Actions runner ("bwrap: loopback: Failed RTM_NEWADDR: Operation not
// permitted"), so every command the reviewer runs fails before executing. We
// use the same no-sandbox mode as the fixer and enforce read-only via the
// prompt instead. (CI is itself a throwaway VM, and the final check gate in
// update.ts re-verifies whatever ends up in the working tree.)
async function reviewChanges(options: AiFixOptions): Promise<ReviewResult> {
  // the reviewer starts without the context of the fixer, which is what makes
  // it a second opinion. It uses the default model of Codex unless one is set.
  const model = Deno.env.get("REVIEW_MODEL");

  // record intent-to-add so any files Codex created also show in `git diff`.
  await $`git add -N .`.quiet();

  const outputFile = await Deno.makeTempFile({
    prefix: "codex-review-",
    suffix: ".json",
  });
  try {
    $.logStep(`Reviewing changes with Codex (${model ?? "default model"})...`);
    const args = [
      "exec",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
    ];
    if (model) {
      args.push("--model", model);
    }
    args.push("--output-last-message", outputFile, buildReviewPrompt(options));
    await $`codex ${args}`;
    return parseReview(await Deno.readTextFile(outputFile));
  } finally {
    await Deno.remove(outputFile).catch(() => {});
  }
}

function buildReviewPrompt(options: AiFixOptions): string {
  return [
    `You are an independent reviewer for dprint-plugin-clang-format, a C++ dprint Wasm plugin that links LLVM/Clang LibFormat (clang-format) into a zero-import wasm32 module. LLVM was just upgraded from ${options.fromVersion} to ${options.toVersion} and another AI edited this repo to reconcile it. Review the UNCOMMITTED working-tree changes.`,
    `IMPORTANT: this is REVIEW ONLY. Read any files and run read-only commands (git diff, cat, grep, find, etc.) to investigate, but you MUST NOT edit, create, or delete any files, and MUST NOT run git commit or git push. Leave the working tree exactly as you found it.`,
    ``,
    `Investigate as needed:`,
    `- Run \`git --no-pager diff\` (and \`git status\`) to see exactly what changed, including any new files. The LLVM version bump itself (the version strings, pixi.toml, and pixi.lock) was done by a script and is expected.`,
    `- Verify against the REAL LLVM ${options.toVersion} source. The pristine release tarball is at \`third_party/cache/llvm-project-${options.toVersion}.src.tar.xz\` (extract it outside the repo), and the patched tree is at \`third_party/llvm-project-${options.toVersion}.src\`.`,
    `- Read the repo files to confirm they are consistent with each other and with upstream.`,
    ``,
    describeWiring(options.toVersion),
    ``,
    `Verify specifically:`,
    `- Every rebased hunk in \`support/patches/\` still does what it did before, on the code it is meant to change, and the patches keep their format (plain unified diffs with \`--- a/\` and \`+++ b/\` headers).`,
    `- New host dependencies were trimmed with small \`#if defined(__wasm__)\` guards in patches where possible, instead of new stubs or fake implementations in \`src/\` or \`support/\`. Unnecessary shim or stub growth is a blocking issue.`,
    `- The options this plugin relies on (\`ColumnLimit\`, \`IndentWidth\`, \`UseTab\` with \`Always\`/\`Never\`, and \`BasedOnStyle\`) still exist in LLVM ${options.toVersion}'s \`clang/include/clang/Format/Format.h\` and \`clang/lib/Format/Format.cpp\`, and no new filesystem-dependent style option needs rejecting like \`BasedOnStyle: file\`.`,
    `- No test was weakened, skipped, or had its expectations changed just to make it pass. Replacing a test input file that no longer exists upstream with a similar one is fine.`,
    `- README.md was NOT modified (its documentation is maintained separately); flag any README.md change as a blocking issue.`,
    `- The plugin version in the \`project()\` call of CMakeLists.txt was not changed.`,
    `- No obvious correctness bugs, and code style matches the surrounding code.`,
    ``,
    `When done, your FINAL message must be ONLY a JSON object (no markdown code fences, no extra prose) of exactly this shape:`,
    `{"approved": true|false, "summary": "one sentence", "issues": [{"severity": "blocking"|"nit", "description": "..."}]}`,
    `Set approved=false if there is any blocking issue; nits alone do not block.`,
  ].join("\n");
}

function parseReview(message: string): ReviewResult {
  const review = JSON.parse(extractJsonObject(message)) as ReviewResult;
  if (typeof review.approved !== "boolean" || !Array.isArray(review.issues)) {
    throw new Error(`Codex review returned malformed JSON:\n${message}`);
  }
  return review;
}

// Codex is instructed to emit only JSON, but tolerate an accidental code fence
// or surrounding prose by extracting the outermost { ... } object.
function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `Could not find a JSON object in Codex review output:\n${text}`,
    );
  }
  return text.slice(start, end + 1);
}

function logReview(review: ReviewResult): void {
  $.log(
    `Review: ${
      review.approved ? "approved" : "changes requested"
    } — ${review.summary}`,
  );
  for (const issue of review.issues) {
    $.logLight(`  [${issue.severity}] ${issue.description}`);
  }
}

// setup ------------------------------------------------------------------------

function requireApiKey(): string {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set. It is required to run the AI fixer and reviewer.",
    );
  }
  return apiKey;
}

async function ensureCodexInstalled(): Promise<void> {
  const found = await $`codex --version`.noThrow().quiet();
  if (found.code === 0) {
    return;
  }
  $.logStep("Installing OpenAI Codex CLI...");
  await $`npm install -g @openai/codex`;
}

// `codex exec` does not read OPENAI_API_KEY on its own -- it needs credentials
// stored via `codex login` first, otherwise its requests go out with no auth
// header and the API returns 401. The key is piped over stdin so it never
// appears in the process arguments.
async function codexLogin(apiKey: string): Promise<void> {
  $.logStep("Authenticating Codex with the OpenAI API key...");
  await $`codex login --with-api-key`.stdinText(apiKey);
}
