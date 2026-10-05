import assert from "node:assert/strict";
import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {test} from "vitest";

const root = new URL("..", import.meta.url).pathname;
const workflowsDir = join(root, ".github/workflows");
const sync = readFileSync(join(workflowsDir, "sync-upstream.yml"), "utf8");
const publish = readFileSync(join(workflowsDir, "publish-alas.yml"), "utf8");
const checkoutSha = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const setupNodeSha = "820762786026740c76f36085b0efc47a31fe5020";

test("pins checkout and setup-node to the reviewed full SHAs in every workflow", () => {
  for (const name of readdirSync(workflowsDir).filter((entry) => entry.endsWith(".yml"))) {
    const workflow = readFileSync(join(workflowsDir, name), "utf8");
    for (const match of workflow.matchAll(/uses:\s*(actions\/(?:checkout|setup-node))@([^\s]+)/g)) {
      const expected = match[1] === "actions/checkout" ? checkoutSha : setupNodeSha;
      assert.equal(match[2], expected, `${name}: ${match[1]}`);
    }
  }
});

test("sync maintenance has no GitHub Issues dependency and persists manual review in a draft PR", () => {
  assert.doesNotMatch(sync, /\bissues:\s*write\b|gh issue/);
  assert.match(sync, /\$GITHUB_STEP_SUMMARY/);
  assert.match(sync, /gh pr create[\s\S]*--draft/);
  assert.match(sync, /gh pr ready[\s\S]*--undo/);
  assert.match(sync, /scripts\/sync-candidate\.mjs/);
  assert.match(sync, /docs\/alas-downstream-patches\.json/);
  assert.match(sync, /refs\/alas-upstream-main/);
});

test("sync reports absorbed, overlap, conflicts, and workflow changes as fail-closed manual review", () => {
  for (const marker of ["absorbed", "overlap", "conflict", "workflowChanges", "manualReview"]) {
    assert.match(sync, new RegExp(marker));
  }
  assert.match(sync, /exit 1/);
});

test("publish verifies the declared stable tag against the exact upstream-main merge-base", () => {
  assert.match(publish, /upstream_tag:/);
  assert.match(publish, /refs\/alas-upstream-main/);
  assert.match(publish, /verify-alas-source\.mjs/);
  assert.doesNotMatch(publish, /merge-base --is-ancestor/);
  assert.match(publish, /environment: npm/);
  assert.match(publish, /id-token: write/);
});
