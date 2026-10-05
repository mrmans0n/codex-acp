#!/usr/bin/env node

import {execFileSync} from "node:child_process";

const FULL_COMMIT = /^[0-9a-f]{40}$/i;
const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const KNOWN_PATCH_IDENTITIES = Object.freeze([
  Object.freeze({
    name: "goal-opt-in",
    commit: "97aa595ba69c62e896375ea2442358d45d66af74",
  }),
  Object.freeze({
    name: "async-tasks-opt-in",
    commit: "16817016d25a9eed9f3dc7cd1cbdf446569e179d",
  }),
]);

function git(cwd, args, options = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    input: options.input,
    maxBuffer: 128 * 1024 * 1024,
  }).trim();
}

export function validatePatchLedger(ledger, {expectedPatchIdentities = KNOWN_PATCH_IDENTITIES} = {}) {
  const errors = [];
  if (ledger?.schemaVersion !== 2) errors.push("schemaVersion must be 2");
  if (!STABLE_TAG.test(String(ledger?.baseTag ?? ""))) errors.push("baseTag must be a stable vX.Y.Z tag");
  if (!Array.isArray(ledger?.patches) || ledger.patches.length === 0) {
    errors.push("patches must be a non-empty array");
  } else {
    const names = new Set();
    const commits = new Set();
    ledger.patches.forEach((patch, index) => {
      const prefix = `patches[${index}]`;
      if (!patch || typeof patch.name !== "string" || patch.name.length === 0) errors.push(`${prefix}.name is required`);
      if (!FULL_COMMIT.test(String(patch?.commit ?? ""))) errors.push(`${prefix}.commit must be a full commit SHA`);
      if (patch?.appliedCommit !== undefined && !FULL_COMMIT.test(String(patch.appliedCommit))) {
        errors.push(`${prefix}.appliedCommit must be a full commit SHA when present`);
      }
      if (patch?.retiredCommits !== undefined &&
          (!Array.isArray(patch.retiredCommits) || patch.retiredCommits.some((commit) => !FULL_COMMIT.test(String(commit))))) {
        errors.push(`${prefix}.retiredCommits must be an array of full commit SHAs when present`);
      }
      const disposition = patch?.disposition ?? "active";
      const retiredCommits = patch?.retiredCommits ?? [];
      if (!["active", "dropped"].includes(disposition)) {
        errors.push(`${prefix}.disposition must be active or dropped`);
      }
      if (patch?.appliedCommit !== undefined && patch.appliedCommit === patch.commit) {
        errors.push(`${prefix}.appliedCommit must differ from the anchored original commit`);
      }
      if (patch?.appliedCommit !== undefined && retiredCommits.includes(patch.appliedCommit)) {
        errors.push(`${prefix}.appliedCommit must not also be retired`);
      }
      if (patch?.appliedCommit !== undefined &&
          (disposition !== "active" || !retiredCommits.includes(patch.commit))) {
        errors.push(`${prefix}.appliedCommit requires active disposition and the original commit in retiredCommits`);
      }
      if (disposition === "dropped" &&
          (patch?.appliedCommit !== undefined || !retiredCommits.includes(patch.commit))) {
        errors.push(`${prefix}.dropped disposition requires no appliedCommit and the original commit in retiredCommits`);
      }
      if (patch?.appliedCommit !== undefined || disposition === "dropped") {
        const transition = patch?.lastResolution;
        const expectedAction = disposition === "dropped" ? "drop" : "adapt";
        if (!transition || transition.action !== expectedAction ||
            !STABLE_TAG.test(String(transition.fromTag ?? "")) ||
            !STABLE_TAG.test(String(transition.toTag ?? "")) ||
            !FULL_COMMIT.test(String(transition.originalCommit ?? "")) ||
            !retiredCommits.includes(transition.originalCommit) ||
            (expectedAction === "adapt" && transition.replacementCommit !== patch.appliedCommit) ||
            (expectedAction === "drop" && transition.replacementCommit !== undefined)) {
          errors.push(`${prefix}.lastResolution must authenticate the ${expectedAction} transition for the current patch state`);
        }
      }
      if (names.has(patch?.name)) errors.push(`duplicate patch name ${patch.name}`);
      if (commits.has(patch?.commit)) errors.push(`duplicate patch commit ${patch.commit}`);
      names.add(patch?.name);
      commits.add(patch?.commit);
      if (!Object.hasOwn(patch ?? {}, "upstreamPr") ||
          !(patch.upstreamPr === null || Number.isSafeInteger(patch.upstreamPr) && patch.upstreamPr > 0)) {
        errors.push(`${prefix}.upstreamPr must be a positive PR number or null`);
      }
      if (!Array.isArray(patch?.files) || patch.files.length === 0 || patch.files.some((path) => typeof path !== "string" || path.length === 0)) {
        errors.push(`${prefix}.files must be a non-empty string array`);
      }
      if (!Array.isArray(patch?.tests) || patch.tests.length === 0 || patch.tests.some((path) => typeof path !== "string" || path.length === 0)) {
        errors.push(`${prefix}.tests must be a non-empty string array`);
      }
    });
    const expected = new Map(expectedPatchIdentities.map(({name, commit}) => [name, commit]));
    for (const [name, commit] of expected) {
      const patch = ledger.patches.find((candidate) => candidate?.name === name);
      if (!patch) errors.push(`missing known functional patch ${name}`);
      else if (patch.commit !== commit) errors.push(`known functional patch identity mismatch for ${name}`);
    }
    for (const patch of ledger.patches) {
      if (!expected.has(patch?.name)) errors.push(`unexpected functional patch ${patch?.name ?? "unnamed"}`);
    }
    if (ledger.patches.length !== expected.size) {
      errors.push(`known functional patch count must be exactly ${expected.size}`);
    }
    const actualIdentities = ledger.patches.map(({name, commit}) => ({name, commit}));
    const orderedExpectedIdentities = expectedPatchIdentities.map(({name, commit}) => ({name, commit}));
    if (JSON.stringify(actualIdentities) !== JSON.stringify(orderedExpectedIdentities)) {
      errors.push("known functional patch identities must appear in the exact anchored order");
    }
  }
  if (errors.length > 0) throw new Error(`Invalid downstream patch ledger: ${errors.join("; ")}`);
  return ledger;
}

function patchId(cwd, commit) {
  const patch = git(cwd, ["show", "--pretty=format:", "--binary", commit]);
  if (!patch) return null;
  const output = git(cwd, ["patch-id", "--stable"], {input: `${patch}\n`});
  return output.split(/\s+/)[0] || null;
}

export function classifyDownstreamPatches({
  cwd,
  ledger,
  baseRef,
  targetRef,
  expectedPatchIdentities = KNOWN_PATCH_IDENTITIES,
}) {
  validatePatchLedger(ledger, {expectedPatchIdentities});
  git(cwd, ["rev-parse", "--verify", `${baseRef}^{commit}`]);
  git(cwd, ["rev-parse", "--verify", `${targetRef}^{commit}`]);

  const ledgerFiles = [...new Set(ledger.patches.flatMap((patch) => patch.files))];
  const upstreamCommits = git(cwd, ["rev-list", "--reverse", targetRef, "--", ...ledgerFiles])
    .split("\n").filter(Boolean);
  const upstreamPatchIds = new Set(upstreamCommits.map((commit) => patchId(cwd, commit)).filter(Boolean));
  const changedFiles = new Set(git(cwd, ["diff", "--name-only", baseRef, targetRef]).split("\n").filter(Boolean));

  return ledger.patches.map((patch) => {
    const originalCommit = patch.commit;
    const currentCommit = patch.appliedCommit ?? originalCommit;
    const id = patchId(cwd, currentCommit);
    const overlappingFiles = [...new Set(patch.files)].filter((path) => changedFiles.has(path)).sort();
    const classification = id && upstreamPatchIds.has(id)
      ? "absorbed"
      : overlappingFiles.length > 0 ? "overlap" : "unaffected";
    return {
      ...patch,
      originalCommit,
      commit: currentCommit,
      patchId: id,
      classification,
      overlappingFiles,
    };
  });
}
