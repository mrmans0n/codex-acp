import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "vitest";
import {verifyAlasSource} from "./verify-alas-source.mjs";

const git = (cwd, ...args) => execFileSync("git", args, {
  cwd,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
}).trim();

function commitFile(cwd, path, contents, message) {
  writeFileSync(join(cwd, path), contents);
  git(cwd, "add", path);
  git(cwd, "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "alas-source-"));
  const cwd = join(root, "repo");
  mkdirSync(cwd);
  git(cwd, "init", "-b", "upstream");
  git(cwd, "config", "user.name", "Fixture");
  git(cwd, "config", "user.email", "fixture@example.test");
  writeFileSync(join(cwd, "package.json"), '{"version":"2.1.0"}\n');
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "stable");
  const stable = git(cwd, "rev-parse", "HEAD");
  git(cwd, "tag", "v2.1.0");
  const preview = commitFile(cwd, "preview.txt", "preview\n", "post-stable preview");

  git(cwd, "checkout", "-b", "clean", stable);
  const clean = commitFile(cwd, "downstream.txt", "downstream\n", "downstream");
  git(cwd, "branch", "alas-clean", clean);

  git(cwd, "checkout", "-b", "contaminated", preview);
  const contaminated = commitFile(cwd, "downstream.txt", "downstream\n", "downstream");
  git(cwd, "branch", "alas-contaminated", contaminated);
  return {root, cwd, stable, clean, contaminated};
}

test("accepts a source whose merge-base with upstream main is exactly the declared stable tag", () => {
  const f = fixture();
  try {
    assert.deepEqual(verifyAlasSource({
      cwd: f.cwd,
      sourceCommit: f.clean,
      alasRef: "alas-clean",
      upstreamTag: "v2.1.0",
      upstreamMainRef: "upstream",
      packageVersion: "2.1.0",
    }), {sourceCommit: f.clean, upstreamVersion: "2.1.0", upstreamCommit: f.stable});
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("rejects post-tag upstream contamination even when the stable tag is an ancestor", () => {
  const f = fixture();
  try {
    assert.throws(() => verifyAlasSource({
      cwd: f.cwd,
      sourceCommit: f.contaminated,
      alasRef: "alas-contaminated",
      upstreamTag: "v2.1.0",
      upstreamMainRef: "upstream",
      packageVersion: "2.1.0",
    }), /merge-base.*exactly.*v2\.1\.0/i);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});
