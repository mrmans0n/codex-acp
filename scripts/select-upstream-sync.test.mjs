import assert from "node:assert/strict";
import { test } from "vitest";
import { selectUpstreamSync } from "./select-upstream-sync.mjs";

test("selects the newest stable tag by numeric semver order", () => {
  assert.deepEqual(selectUpstreamSync({
    tags: ["v2.9.9", "v2.10.0", "v1.99.99"], openHeads: [],
  }), { tag: "v2.10.0", branch: "sync/upstream-2.10.0", staleHeads: [] });
});

test("ignores prereleases and malformed versions", () => {
  assert.deepEqual(selectUpstreamSync({
    tags: ["v2.1.1", "v3.0.0-rc.1", "v3.0.0-preview.4", "v03.0.0", "unrelated"],
    openHeads: [],
  }), { tag: "v2.1.1", branch: "sync/upstream-2.1.1", staleHeads: [] });
  assert.equal(selectUpstreamSync({ tags: ["v3.0.0-rc.1"], openHeads: [] }), null);
});

test("does no work when the newest stable tag is already in alas", () => {
  assert.equal(selectUpstreamSync({
    tags: [{ name: "v2.1.0", merged: false }, { name: "v2.1.1", merged: true }],
    openHeads: ["sync/upstream-2.1.0"],
  }), null);
});

test("reuses the canonical head of an open sync PR", () => {
  assert.deepEqual(selectUpstreamSync({
    tags: ["v2.1.1"], openHeads: ["sync/upstream-2.1.1", "feature/other"],
  }), { tag: "v2.1.1", branch: "sync/upstream-2.1.1", staleHeads: [] });
});

test("replaces older sync heads with the newest stable head", () => {
  assert.deepEqual(selectUpstreamSync({
    tags: ["v2.1.0", "v2.1.1"],
    openHeads: ["sync/upstream-2.1.0", "feature/other", "sync/upstream-2.1.1"],
  }), { tag: "v2.1.1", branch: "sync/upstream-2.1.1", staleHeads: ["sync/upstream-2.1.0"] });
});

test.each([false, true])(
  "closes a stale PR only when its current head is in the replacement (concurrent push: %s)",
  async (concurrentPush) => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "upstream-closure-"));
    const repo = join(root, "repo");
    const origin = join(root, "origin.git");
    const git = (...args) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
    try {
      mkdirSync(repo);
      git("init", "--bare", origin);
      git("init", "-b", "alas");
      git("config", "user.name", "Fixture");
      git("config", "user.email", "fixture@example.test");
      writeFileSync(join(repo, "base"), "base\n");
      git("add", ".");
      git("commit", "-qm", "base");
      git("remote", "add", "origin", origin);
      const staleBranch = "sync/upstream-2.1.0";
      git("checkout", "-b", staleBranch);
      writeFileSync(join(repo, "maintainer"), "first edit\n");
      git("add", ".");
      git("commit", "-qm", "maintainer edit");
      git("push", "origin", staleBranch);
      git("fetch", "origin", staleBranch);
      git("checkout", "-b", "sync/upstream-2.1.1", "alas");
      git("merge", "--no-edit", `origin/${staleBranch}`);
      git("push", "origin", "sync/upstream-2.1.1");
      const replacement = git("rev-parse", "HEAD");
      if (concurrentPush) {
        git("checkout", staleBranch);
        writeFileSync(join(repo, "maintainer"), "second edit after merge\n");
        git("add", ".");
        git("commit", "-qm", "concurrent maintainer edit");
        git("push", "origin", staleBranch);
        git("checkout", "sync/upstream-2.1.1");
      }
      const workflow = readFileSync(
        new URL("../.github/workflows/sync-upstream.yml", import.meta.url),
        "utf8",
      );
      const closure = workflow
        .split("          jq -r --slurpfile selection ")[1]
        .split("\n")
        .map((line, index) =>
          index === 0 ? `jq -r --slurpfile selection ${line}` : line.slice(10),
        )
        .join("\n")
        .replaceAll("/tmp/alas-sync-selection.json", join(root, "selection.json"))
        .replaceAll("/tmp/alas-sync-pulls.json", join(root, "pulls.json"));
      writeFileSync(join(root, "selection.json"), JSON.stringify({ staleHeads: [staleBranch] }));
      writeFileSync(
        join(root, "pulls.json"),
        JSON.stringify([{ number: 10, head: { ref: staleBranch } }]),
      );
      const bin = join(root, "bin");
      mkdirSync(bin);
      const closed = join(root, "closed");
      writeFileSync(closed, "");
      writeFileSync(
        join(bin, "gh"),
        `#!/bin/sh\nif [ "$1" = api ]; then\n git --git-dir="$FIXTURE_ORIGIN" rev-parse refs/heads/${staleBranch}\nelif [ "$1 $2" = "pr close" ]; then\n echo "$3" >> "$FIXTURE_CLOSED"\nelse\n exit 1\nfi\n`,
        { mode: 0o755 },
      );
      const output = execFileSync("bash", ["-e", "-o", "pipefail", "-c", closure], {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GITHUB_REPOSITORY: "fixture/repository",
          FIXTURE_ORIGIN: origin,
          FIXTURE_CLOSED: closed,
        },
      });
      assert.equal(readFileSync(closed, "utf8"), concurrentPush ? "" : "10\n");
      if (concurrentPush) assert.match(output, /Leaving stale PR 10 open/);
      assert.equal(git("rev-parse", "HEAD"), replacement);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
