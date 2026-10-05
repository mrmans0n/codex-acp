import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "vitest";
import {
  classifyDownstreamPatches,
  validatePatchLedger,
} from "./downstream-patches.mjs";

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
    schemaVersion: 1,
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
      ledger: {schemaVersion: 1, patches: [f.ledger.patches[0]]},
      baseRef: baseAfterEquivalent,
      targetRef: f.target,
    });
    assert.equal(result[0].classification, "absorbed");
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("requires a versioned ledger with patch identity, upstream PR field, files, and tests", () => {
  assert.throws(() => validatePatchLedger({schemaVersion: 1, patches: [{name: "incomplete"}]}),
    /commit.*upstreamPr.*files.*tests/s);
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
