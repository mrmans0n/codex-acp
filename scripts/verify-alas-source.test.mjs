import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "vitest";
import {verifyAlasSource} from "./verify-alas-source.mjs";
import {verifySyncReviewArtifact} from "./sync-review.mjs";

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
  writeFileSync(join(cwd, "package.json"), '{"version":"2.0.0"}\n');
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "previous stable");
  const previous = git(cwd, "rev-parse", "HEAD");
  git(cwd, "tag", "v2.0.0");
  writeFileSync(join(cwd, "package.json"), '{"version":"2.1.0"}\n');
  const stable = commitFile(cwd, "stable.txt", "stable\n", "stable");
  git(cwd, "tag", "v2.1.0");
  const preview = commitFile(cwd, "preview.txt", "preview\n", "post-stable preview");

  git(cwd, "checkout", "-b", "clean", previous);
  const downstream = commitFile(cwd, "downstream.txt", "downstream\n", "downstream");
  git(cwd, "checkout", "-b", "exact", stable);
  commitFile(cwd, "downstream.txt", "downstream\n", "downstream");
  const exact = git(cwd, "rev-parse", "HEAD");
  git(cwd, "checkout", "clean");
  git(cwd, "merge", "--no-ff", "exact", "-m", `chore: integrate exact upstream ${stable.slice(0, 12)}`);
  const clean = git(cwd, "rev-parse", "HEAD");
  git(cwd, "branch", "alas-clean", clean);

  git(cwd, "checkout", "-b", "contaminated", preview);
  const contaminated = commitFile(cwd, "downstream.txt", "downstream\n", "downstream");
  git(cwd, "branch", "alas-contaminated", contaminated);
  return {root, cwd, previous, stable, downstream, exact, clean, contaminated};
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
    }), {
      sourceCommit: f.clean,
      upstreamVersion: "2.1.0",
      upstreamCommit: f.stable,
      reviewBaseTag: "v2.0.0",
      integrationCommit: f.clean,
      exactCandidateCommit: f.exact,
      previousAlas: f.downstream,
      canonicalHead: null,
    });
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("accepts only a normal protected-branch merge wrapper around the reviewed integration", () => {
  const f = fixture();
  try {
    const wrapper = git(f.cwd, "commit-tree", `${f.clean}^{tree}`,
      "-p", `${f.clean}^1`, "-p", f.clean, "-m", "Merge pull request #42 from sync/upstream-2.1.0");
    git(f.cwd, "branch", "alas-wrapper", wrapper);
    assert.deepEqual(verifyAlasSource({
      cwd: f.cwd,
      sourceCommit: wrapper,
      alasRef: "alas-wrapper",
      upstreamTag: "v2.1.0",
      upstreamMainRef: "upstream",
      packageVersion: "2.1.0",
    }), {
      sourceCommit: wrapper,
      upstreamVersion: "2.1.0",
      upstreamCommit: f.stable,
      reviewBaseTag: "v2.0.0",
      integrationCommit: f.clean,
      exactCandidateCommit: f.exact,
      previousAlas: f.downstream,
      canonicalHead: null,
    });
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("rejects protected-branch wrappers with a changed tree or the wrong first parent", () => {
  const f = fixture();
  try {
    git(f.cwd, "checkout", "-B", "wrapper-tree", f.clean);
    const changed = commitFile(f.cwd, "unreviewed.txt", "unreviewed\n", "unreviewed wrapper tree");
    const badTree = git(f.cwd, "commit-tree", `${changed}^{tree}`,
      "-p", `${f.clean}^1`, "-p", f.clean, "-m", "Merge pull request #43");
    const badParent = git(f.cwd, "commit-tree", `${f.clean}^{tree}`,
      "-p", f.previous, "-p", f.clean, "-m", "Merge pull request #44");
    for (const [branch, sourceCommit] of [["alas-wrapper-tree", badTree], ["alas-wrapper-parent", badParent]]) {
      git(f.cwd, "branch", branch, sourceCommit);
      assert.throws(() => verifyAlasSource({
        cwd: f.cwd,
        sourceCommit,
        alasRef: branch,
        upstreamTag: "v2.1.0",
        upstreamMainRef: "upstream",
        packageVersion: "2.1.0",
      }), /reviewed protected integration/i);
    }
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("rejects a redundant or arbitrary canonical parent that is not a descendant of the previous protected head", () => {
  const f = fixture();
  try {
    const forged = git(f.cwd, "commit-tree", `${f.exact}^{tree}`,
      "-p", f.downstream, "-p", f.exact, "-p", f.previous,
      "-m", `chore: integrate exact upstream ${f.stable.slice(0, 12)}`);
    git(f.cwd, "branch", "alas-forged-canonical", forged);
    assert.throws(() => verifyAlasSource({
      cwd: f.cwd,
      sourceCommit: forged,
      alasRef: "alas-forged-canonical",
      upstreamTag: "v2.1.0",
      upstreamMainRef: "upstream",
      packageVersion: "2.1.0",
    }), /reviewed protected integration/i);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("rejects arbitrary commits after the reviewed integration even when tree-identical or metadata-only", () => {
  const f = fixture();
  try {
    git(f.cwd, "checkout", "-B", "post-integration", f.clean);
    git(f.cwd, "commit", "--allow-empty", "-m", "empty post-integration commit");
    const empty = git(f.cwd, "rev-parse", "HEAD");
    const metadata = commitFile(f.cwd, "docs-review.json", "{}\n", "review-only metadata after integration");
    for (const [branch, sourceCommit] of [["alas-post-empty", empty], ["alas-post-metadata", metadata]]) {
      git(f.cwd, "branch", branch, sourceCommit);
      assert.throws(() => verifyAlasSource({
        cwd: f.cwd,
        sourceCommit,
        alasRef: branch,
        upstreamTag: "v2.1.0",
        upstreamMainRef: "upstream",
        packageVersion: "2.1.0",
      }), /reviewed integration|protected integration|source commit/i);
    }
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

test("rejects a forged sync-review fromTag using the base derived from integration history", () => {
  const f = fixture();
  try {
    const source = verifyAlasSource({
      cwd: f.cwd,
      sourceCommit: f.clean,
      alasRef: "alas-clean",
      upstreamTag: "v2.1.0",
      upstreamMainRef: "upstream",
      packageVersion: "2.1.0",
    });
    const classifications = [{
      name: "downstream",
      commit: f.downstream,
      patchId: "a".repeat(40),
      classification: "unaffected",
      overlappingFiles: [],
      tests: ["downstream.test.ts"],
    }];
    const review = {
      schemaVersion: 2,
      fromTag: "v2.1.0",
      toTag: "v2.1.0",
      toCommit: f.stable,
      canonicalHead: null,
      patches: [{
        name: "downstream",
        commit: f.downstream,
        patchId: "a".repeat(40),
        classification: "unaffected",
        overlappingFiles: [],
        resolution: {
          action: "retain",
          automatic: true,
          rationale: "No equivalent or overlapping upstream stable change was detected.",
          tests: ["downstream.test.ts"],
        },
      }],
      preservedCommits: [],
      resolved: true,
    };
    assert.throws(() => verifySyncReviewArtifact({
      review,
      fromTag: source.reviewBaseTag,
      toTag: "v2.1.0",
      toCommit: f.stable,
      classifications,
    }), /fromTag mismatch/i);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});
