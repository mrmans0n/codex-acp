#!/usr/bin/env node

import {execFileSync} from "node:child_process";

const FULL_COMMIT = /^[0-9a-f]{40}$/i;

function git(cwd, args, options = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    input: options.input,
    maxBuffer: 128 * 1024 * 1024,
  }).trim();
}

export function validatePatchLedger(ledger) {
  const errors = [];
  if (ledger?.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!Array.isArray(ledger?.patches) || ledger.patches.length === 0) {
    errors.push("patches must be a non-empty array");
  } else {
    ledger.patches.forEach((patch, index) => {
      const prefix = `patches[${index}]`;
      if (!patch || typeof patch.name !== "string" || patch.name.length === 0) errors.push(`${prefix}.name is required`);
      if (!FULL_COMMIT.test(String(patch?.commit ?? ""))) errors.push(`${prefix}.commit must be a full commit SHA`);
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

export function classifyDownstreamPatches({cwd, ledger, baseRef, targetRef}) {
  validatePatchLedger(ledger);
  git(cwd, ["rev-parse", "--verify", `${baseRef}^{commit}`]);
  git(cwd, ["rev-parse", "--verify", `${targetRef}^{commit}`]);

  const ledgerFiles = [...new Set(ledger.patches.flatMap((patch) => patch.files))];
  const upstreamCommits = git(cwd, ["rev-list", "--reverse", targetRef, "--", ...ledgerFiles])
    .split("\n").filter(Boolean);
  const upstreamPatchIds = new Set(upstreamCommits.map((commit) => patchId(cwd, commit)).filter(Boolean));
  const changedFiles = new Set(git(cwd, ["diff", "--name-only", baseRef, targetRef]).split("\n").filter(Boolean));

  return ledger.patches.map((patch) => {
    const id = patchId(cwd, patch.commit);
    const overlappingFiles = [...new Set(patch.files)].filter((path) => changedFiles.has(path)).sort();
    const classification = id && upstreamPatchIds.has(id)
      ? "absorbed"
      : overlappingFiles.length > 0 ? "overlap" : "unaffected";
    return {...patch, patchId: id, classification, overlappingFiles};
  });
}
