import assert from "node:assert/strict";
import {execFileSync, spawnSync} from "node:child_process";
import {mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {test} from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/sync-upstream.yml", import.meta.url), "utf8");
function block(name, yaml = workflow) {
  const step = yaml.split(`      - name: ${name}\n`)[1]?.split("\n      - ")[0];
  assert.ok(step, `Missing workflow step: ${name}`);
  return step.split("        run: |\n")[1].split("\n").map(line => line.slice(10)).join("\n");
}
const git = (cwd, ...args) => execFileSync("git", args, {cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]}).trim();
function fixture(workflowChange = false) {
  const root = mkdtempSync(`${tmpdir()}/alas-sync-regression-`);
  const cwd = `${root}/repo`;
  mkdirSync(cwd);
  git(cwd, "init", "-b", "alas");
  git(cwd, "config", "user.name", "Test");
  git(cwd, "config", "user.email", "test@example.com");
  writeFileSync(`${cwd}/base.txt`, "base\n");
  git(cwd, "add", "."); git(cwd, "commit", "-m", "base");
  git(cwd, "checkout", "-b", "upstream");
  writeFileSync(`${cwd}/upstream.txt`, "upstream\n");
  if (workflowChange) {
    mkdirSync(`${cwd}/.github/workflows`, {recursive: true});
    writeFileSync(`${cwd}/.github/workflows/changed.yml`, "name: Changed\n");
  }
  git(cwd, "add", "."); git(cwd, "commit", "-m", "upstream");
  const upstream = git(cwd, "rev-parse", "HEAD");
  git(cwd, "update-ref", "refs/alas-upstream-tags/v2.1.1", upstream);
  git(cwd, "checkout", "alas");
  writeFileSync(`${cwd}/downstream.txt`, "downstream\n");
  git(cwd, "add", "."); git(cwd, "commit", "-m", "downstream");
  const alas = git(cwd, "rev-parse", "HEAD");
  git(cwd, "init", "--bare", `${root}/remote.git`);
  git(cwd, "remote", "add", "origin", `${root}/remote.git`);
  git(cwd, "push", "origin", "alas");
  writeFileSync("/tmp/alas-sync-selection.json", JSON.stringify({staleHeads: []}));
  return {root, cwd, upstream, alas};
}
function run(code, f, env = {}) {
  writeFileSync(`${f.root}/outputs`, "");
  return spawnSync("bash", ["-e", "-o", "pipefail", "-c", code], {
    cwd: f.cwd, encoding: "utf8", env: {...process.env, TAG: "v2.1.1", BRANCH: "sync/upstream-2.1.1",
      GITHUB_REPOSITORY: "test/repo", GITHUB_OUTPUT: `${f.root}/outputs`, ...env},
  });
}
function github(f, issues = []) {
  mkdirSync(`${f.root}/bin`);
  writeFileSync(`${f.root}/issues.json`, JSON.stringify(issues));
  writeFileSync(`${f.root}/calls`, "");
  writeFileSync(`${f.root}/bin/gh`, `#!/bin/bash
printf '%s\\n' "$*" >> "$GH_LOG"
if [[ "$1 $2" == "issue list" ]]; then cat "$GH_ISSUES"; fi
if [[ "$1 $2" == "pr create" && "$FAIL_PR" == "true" ]]; then exit 1; fi
`, {mode: 0o755});
  return {PATH: `${f.root}/bin:${process.env.PATH}`, GH_LOG: `${f.root}/calls`, GH_ISSUES: `${f.root}/issues.json`};
}

test.each(["sync/upstream-2.1.1", "sync/upstream-2.1.0"])("retains maintainer commits from remote %s", head => {
  const f = fixture();
  try {
    git(f.cwd, "checkout", "-b", head);
    writeFileSync(`${f.cwd}/reviewed.txt`, "maintainer compatibility edit\n");
    git(f.cwd, "add", "."); git(f.cwd, "commit", "-m", "review fix");
    const reviewed = git(f.cwd, "rev-parse", "HEAD");
    git(f.cwd, "push", "origin", head);
    git(f.cwd, "checkout", "alas");
    writeFileSync("/tmp/alas-sync-selection.json", JSON.stringify({staleHeads: head.endsWith("2.1.0") ? [head] : []}));
    const result = run(block("Merge upstream on the canonical sync branch"), f);
    assert.equal(result.status, 0, result.stderr);
    git(f.cwd, "merge-base", "--is-ancestor", reviewed, "HEAD");
    git(f.cwd, "merge-base", "--is-ancestor", f.upstream, "HEAD");
    assert.equal(readFileSync(`${f.cwd}/reviewed.txt`, "utf8"), "maintainer compatibility edit\n");
    assert.equal(git(f.cwd, "rev-parse", "origin/alas"), f.alas);
    assert.equal(git(f.cwd, "ls-remote", "origin", "refs/heads/sync/upstream-2.1.1").split(/\s/)[0], git(f.cwd, "rev-parse", "HEAD"));
  } finally {rmSync(f.root, {recursive: true, force: true});}
});

test("rejects a concurrent maintainer push instead of overwriting it", () => {
  const f = fixture();
  try {
    const head = "sync/upstream-2.1.1";
    git(f.cwd, "checkout", "-b", head); git(f.cwd, "push", "origin", head);
    writeFileSync(`${f.cwd}/concurrent.txt`, "late maintainer edit\n");
    git(f.cwd, "add", "."); git(f.cwd, "commit", "-m", "concurrent review fix");
    const concurrent = git(f.cwd, "rev-parse", "HEAD");
    git(f.cwd, "push", "origin", "HEAD:refs/heads/race-object");
    git(f.cwd, "checkout", "alas");
    const realGit = execFileSync("which", ["git"], {encoding: "utf8"}).trim();
    mkdirSync(`${f.root}/bin`);
    writeFileSync(`${f.root}/bin/git`, `#!/bin/bash
if [[ "$1" == push ]]; then
  "$REAL_GIT" --git-dir="$LOCAL_REMOTE" update-ref refs/heads/sync/upstream-2.1.1 "$CONCURRENT_SHA"
fi
exec "$REAL_GIT" "$@"
`, {mode: 0o755});
    const result = run(block("Merge upstream on the canonical sync branch"), f,
      {PATH: `${f.root}/bin:${process.env.PATH}`, REAL_GIT: realGit,
       LOCAL_REMOTE: `${f.root}/remote.git`, CONCURRENT_SHA: concurrent});
    assert.notEqual(result.status, 0);
    assert.equal(git(f.cwd, "ls-remote", "origin", `refs/heads/${head}`).split(/\s/)[0], concurrent);
  } finally {rmSync(f.root, {recursive: true, force: true});}
});

test("aborts a conflicting merge and leaves remote sync edits intact", () => {
  const f = fixture();
  try {
    const head = "sync/upstream-2.1.1";
    git(f.cwd, "checkout", "-b", head);
    writeFileSync(`${f.cwd}/upstream.txt`, "maintainer version\n");
    git(f.cwd, "add", "."); git(f.cwd, "commit", "-m", "review fix");
    const reviewed = git(f.cwd, "rev-parse", "HEAD"); git(f.cwd, "push", "origin", head);
    git(f.cwd, "checkout", "alas");
    const result = run(block("Merge upstream on the canonical sync branch"), f);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(`${f.root}/outputs`, "utf8"), "conflict=true\n");
    assert.equal(readFileSync("/tmp/alas-sync-conflicts.txt", "utf8"), "upstream.txt\n");
    assert.equal(git(f.cwd, "rev-parse", "HEAD"), reviewed);
    assert.equal(git(f.cwd, "status", "--porcelain"), "");
    assert.equal(git(f.cwd, "ls-remote", "origin", `refs/heads/${head}`).split(/\s/)[0], reviewed);
  } finally {rmSync(f.root, {recursive: true, force: true});}
});

test("stops before pushing workflow-file changes and reports the files", () => {
  const f = fixture(true);
  try {
    const result = run(block("Merge upstream on the canonical sync branch"), f);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(f.cwd, "ls-remote", "origin", "refs/heads/sync/upstream-2.1.1"), "");
    assert.match(readFileSync(`${f.root}/outputs`, "utf8"), /manual=true/);
    assert.equal(readFileSync("/tmp/alas-sync-workflows.txt", "utf8"), ".github/workflows/changed.yml\n");
  } finally {rmSync(f.root, {recursive: true, force: true});}
});

test.each([false, true])("creates or updates one actionable manual-sync issue for workflow changes: %s", manual => {
  const f = fixture();
  try {
    const env = github(f);
    writeFileSync("/tmp/alas-sync-workflows.txt", ".github/workflows/changed.yml\n");
    writeFileSync("/tmp/alas-sync-conflicts.txt", "upstream.txt\n");
    writeFileSync("/tmp/alas-sync-merge-refs.txt", "origin/alas\nrefs/alas-upstream-tags/v2.1.1\n");
    for (const existing of [null,
      {number: 10, title: "Upstream synchronization required: v2.1.1", body: "manual"},
      {number: 10, title: "Upstream synchronization conflict", body: "Merging upstream tag v2.1.1 into alas failed."},
    ]) {
      writeFileSync(`${f.root}/calls`, "");
      writeFileSync(`${f.root}/issues.json`, JSON.stringify(existing ? [existing] : []));
      const result = run(block("Create or update the manual-sync issue"), f, {...env, MANUAL: String(manual)});
      assert.equal(result.status, 1, result.stderr);
      const calls = readFileSync(`${f.root}/calls`, "utf8");
      assert.match(calls, existing ? /issue edit 10 / : /issue create /);
      const body = readFileSync("/tmp/alas-sync-issue.md", "utf8");
      assert.match(body, /v2\.1\.1/);
      if (manual) {
        assert.match(body, /\.github\/workflows\/changed\.yml/);
        assert.match(body, /GITHUB_TOKEN/);
      } else assert.match(body, /upstream\.txt/);
      assert.match(body, /manual/i);
      assert.doesNotMatch(calls, /pr (create|close)|workflow run/);
    }
  } finally {rmSync(f.root, {recursive: true, force: true});}
});

test("closes resolved tracked issues even when no upstream sync is needed", () => {
  const f = fixture();
  try {
    git(f.cwd, "merge", "--no-edit", f.upstream); git(f.cwd, "push", "origin", "alas");
    mkdirSync(`${f.cwd}/scripts`);
    writeFileSync(`${f.cwd}/scripts/select-upstream-sync.mjs`, readFileSync(new URL("./select-upstream-sync.mjs", import.meta.url)));
    writeFileSync("/tmp/alas-open-pulls.json", "[]");
    const code = block("Select upstream tag and sync head").match(/<<'NODE'\n([\s\S]*?)\nNODE/)[1];
    writeFileSync(`${f.root}/outputs`, "");
    const selection = spawnSync("node", ["--input-type=module", "-e", code], {cwd: f.cwd, encoding: "utf8",
      env: {...process.env, GITHUB_REPOSITORY: "test/repo", GITHUB_OUTPUT: `${f.root}/outputs`}});
    assert.equal(selection.status, 0, selection.stderr);
    assert.equal(readFileSync(`${f.root}/outputs`, "utf8"), "");
    const env = github(f, [
      {number: 10, title: "Upstream synchronization required: v2.1.1", body: "manual"},
      {number: 11, title: "Upstream synchronization required: v2.1.2", body: "manual"},
      {number: 12, title: "Upstream synchronization conflict", body: "Merging upstream tag v2.1.1 into alas failed."},
      {number: 13, title: "Unrelated", body: "v2.1.1"},
    ]);
    const result = run(block("Close resolved synchronization issues"), f, env);
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(`${f.root}/calls`, "utf8");
    assert.match(calls, /issue close 10 /); assert.match(calls, /issue close 12 /);
    assert.doesNotMatch(calls, /issue close (11|13) /);
  } finally {rmSync(f.root, {recursive: true, force: true});}
});

test.each([false, true])("retires an old PR only after replacement succeeds: %s", fail => {
  const f = fixture();
  try {
    const env = github(f);
    writeFileSync("/tmp/alas-sync-pulls.json", JSON.stringify([{number: 7, head: {ref: "sync/upstream-2.1.0"}}]));
    writeFileSync("/tmp/alas-sync-selection.json", JSON.stringify({staleHeads: ["sync/upstream-2.1.0"]}));
    const result = run(block("Create or update one sync PR and request CI"), f, {...env, FAIL_PR: String(fail)});
    assert.equal(result.status, fail ? 1 : 0, result.stderr);
    const calls = readFileSync(`${f.root}/calls`, "utf8");
    if (fail) assert.doesNotMatch(calls, /pr close/);
    else {
      assert.match(calls, /pr close 7 /);
      assert.doesNotMatch(calls, /--delete-branch/);
    }
  } finally {rmSync(f.root, {recursive: true, force: true});}
});

test("records upstream and source identities in release notes", () => {
  const f = fixture();
  try {
    const env = github(f);
    writeFileSync(`${f.root}/bin/gh`, readFileSync(`${f.root}/bin/gh`, "utf8") + '\nif [[ "$1 $2" == "release view" ]]; then exit 1; fi\n');
    const yaml = readFileSync(new URL("../.github/workflows/publish-alas.yml", import.meta.url), "utf8");
    const result = run(block("Create immutable tag and release", yaml), f, {...env,
      VERSION: "2.1.1-alas.1", SOURCE_COMMIT: f.alas, UPSTREAM_VERSION: "2.1.1", UPSTREAM_COMMIT: f.upstream});
    assert.equal(result.status, 0, result.stderr);
    const release = readFileSync(`${f.root}/calls`, "utf8").split("\n").find(line => line.startsWith("release create"));
    assert.ok(release);
    assert.match(release, /Upstream tag: v2\.1\.1/);
    assert.ok(release.includes(`Upstream commit: ${f.upstream}`));
    assert.ok(release.includes(`Source commit: ${f.alas}`));
  } finally {rmSync(f.root, {recursive: true, force: true});}
});
