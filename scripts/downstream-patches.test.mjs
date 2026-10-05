import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "vitest";
import {
  classifyDownstreamPatches,
  KNOWN_PATCH_IDENTITIES,
  validatePatchLedger,
} from "./downstream-patches.mjs";
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
  const root = mkdtempSync(join(tmpdir(), "alas-patches-"));
  const cwd = join(root, "repo");
  mkdirSync(cwd);
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.name", "Fixture");
  git(cwd, "config", "user.email", "fixture@example.test");
  for (const path of ["absorbed.txt", "overlap.txt", "unaffected.txt"]) {
    writeFileSync(join(cwd, path), "base\n");
  }
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "stable base");
  const base = git(cwd, "rev-parse", "HEAD");

  git(cwd, "checkout", "-b", "downstream");
  const absorbed = commitFile(cwd, "absorbed.txt", "downstream\n", "absorbed patch");
  const overlap = commitFile(cwd, "overlap.txt", "downstream\n", "overlap patch");
  const unaffected = commitFile(cwd, "unaffected.txt", "downstream\n", "unaffected patch");

  git(cwd, "checkout", "-b", "upstream", base);
  commitFile(cwd, "absorbed.txt", "downstream\n", "upstream equivalent");
  commitFile(cwd, "overlap.txt", "upstream changed differently\n", "upstream overlap");
  const target = git(cwd, "rev-parse", "HEAD");

  const ledger = {
    schemaVersion: 2,
    baseTag: "v1.0.0",
    patches: [
      {name: "absorbed", commit: absorbed, upstreamPr: 1, files: ["absorbed.txt"], tests: ["absorbed.test.ts"]},
      {name: "overlap", commit: overlap, upstreamPr: 2, files: ["overlap.txt"], tests: ["overlap.test.ts"]},
      {name: "unaffected", commit: unaffected, upstreamPr: null, files: ["unaffected.txt"], tests: ["unaffected.test.ts"]},
    ],
  };
  return {root, cwd, base, target, ledger};
}

test("classifies downstream patches by stable patch equivalence before path overlap", () => {
  const f = fixture();
  try {
    const result = classifyDownstreamPatches({
      cwd: f.cwd,
      ledger: f.ledger,
      baseRef: f.base,
      targetRef: f.target,
      expectedPatchIdentities: f.ledger.patches,
    });
    assert.deepEqual(result.map(({name, classification}) => ({name, classification})), [
      {name: "absorbed", classification: "absorbed"},
      {name: "overlap", classification: "overlap"},
      {name: "unaffected", classification: "unaffected"},
    ]);
    assert.deepEqual(result[1].overlappingFiles, ["overlap.txt"]);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("recognizes an equivalent patch already present before the previous stable tag", () => {
  const f = fixture();
  try {
    const upstreamCommits = git(f.cwd, "rev-list", "--reverse", `${f.base}..${f.target}`).split("\n");
    const baseAfterEquivalent = upstreamCommits[0];
    const result = classifyDownstreamPatches({
      cwd: f.cwd,
      ledger: {schemaVersion: 2, baseTag: "v1.0.0", patches: [f.ledger.patches[0]]},
      baseRef: baseAfterEquivalent,
      targetRef: f.target,
      expectedPatchIdentities: [f.ledger.patches[0]],
    });
    assert.equal(result[0].classification, "absorbed");
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("classifies the currently applied adaptation while retaining the anchored original identity", () => {
  const f = fixture();
  try {
    git(f.cwd, "checkout", "downstream");
    const original = f.ledger.patches[0].commit;
    const adapted = commitFile(f.cwd, "absorbed.txt", "adapted downstream\n", "adapt absorbed patch");
    const ledger = {
      ...f.ledger,
      patches: f.ledger.patches.map((patch, index) => index === 0
        ? {...patch, appliedCommit: adapted, retiredCommits: [original], disposition: "active"}
        : patch),
    };
    const [result] = classifyDownstreamPatches({
      cwd: f.cwd,
      ledger,
      baseRef: f.base,
      targetRef: f.target,
      expectedPatchIdentities: f.ledger.patches,
    });
    assert.equal(result.originalCommit, original);
    assert.equal(result.commit, adapted);
    assert.equal(result.classification, "overlap");
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("requires a versioned ledger with patch identity, upstream PR field, files, and tests", () => {
  assert.throws(() => validatePatchLedger(
    {schemaVersion: 2, baseTag: "v1.0.0", patches: [{name: "incomplete"}]},
    {expectedPatchIdentities: [{name: "incomplete", commit: "1".repeat(40)}]},
  ),
    /commit.*upstreamPr.*files.*tests/s);
});

test("anchors the production ledger to the two known functional patch identities", () => {
  const ledger = JSON.parse(readFileSync(
    new URL("../docs/alas-downstream-patches.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(
    ledger.patches.map(({name, commit}) => ({name, commit})),
    KNOWN_PATCH_IDENTITIES,
  );
  assert.deepEqual(validatePatchLedger(ledger), ledger);
});

test("rejects duplicate, missing, renamed, swapped, and unexpected functional patch identities", () => {
  const ledger = JSON.parse(readFileSync(
    new URL("../docs/alas-downstream-patches.json", import.meta.url),
    "utf8",
  ));
  const cases = [
    {...ledger, patches: [ledger.patches[0], ledger.patches[0]]},
    {...ledger, patches: [ledger.patches[0]]},
    {...ledger, patches: [...ledger.patches].reverse()},
    {...ledger, patches: ledger.patches.map((patch, index) => index === 0 ? {...patch, name: "renamed"} : patch)},
    {...ledger, patches: [
      {...ledger.patches[0], commit: ledger.patches[1].commit},
      {...ledger.patches[1], commit: ledger.patches[0].commit},
    ]},
    {...ledger, patches: [...ledger.patches, {
      name: "invented-functional-patch",
      commit: "f".repeat(40),
      upstreamPr: null,
      files: ["invented.ts"],
      tests: ["invented.test.ts"],
    }]},
  ];
  for (const candidate of cases) {
    assert.throws(() => validatePatchLedger(candidate), /known functional patch|duplicate|missing|unexpected|identity/i);
  }
});

test("the committed ledger matches the exact downstream patch commits", () => {
  const ledger = validatePatchLedger(JSON.parse(readFileSync(
    new URL("../docs/alas-downstream-patches.json", import.meta.url),
    "utf8",
  )));
  assert.equal(ledger.patches.length, 2);
  for (const patch of ledger.patches) {
    const changed = git(new URL("..", import.meta.url).pathname, "diff-tree", "--no-commit-id", "--name-only", "-r", patch.commit)
      .split("\n").filter(Boolean).sort();
    assert.deepEqual([...patch.files].sort(), changed, patch.name);
    assert.ok(patch.tests.every((path) => patch.files.includes(path)), patch.name);
  }
});

test("the committed sync review matches recomputed classifications and has explicit overlap resolutions", () => {
  const cwd = new URL("..", import.meta.url).pathname;
  const ledger = validatePatchLedger(JSON.parse(readFileSync(
    new URL("../docs/alas-downstream-patches.json", import.meta.url),
    "utf8",
  )));
  const review = JSON.parse(readFileSync(
    new URL("../docs/alas-sync-review.json", import.meta.url),
    "utf8",
  ));
  const classifications = classifyDownstreamPatches({
    cwd,
    ledger,
    baseRef: review.fromTag,
    targetRef: review.toTag,
  });
  assert.deepEqual(verifySyncReviewArtifact({
    review,
    fromTag: review.fromTag,
    toTag: review.toTag,
    toCommit: git(cwd, "rev-parse", `${review.toTag}^{commit}`),
    classifications,
  }), review);
  assert.ok(review.patches.every((patch) => patch.classification === "overlap"));
  assert.ok(review.patches.every((patch) => patch.resolution.automatic === false));
});
