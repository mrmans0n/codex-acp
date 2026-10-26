const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const FULL_COMMIT = /^[0-9a-f]{40}$/i;

function parts(value, pattern, label) {
  const match = pattern.exec(String(value ?? ""));
  if (!match) throw new Error(`${label} must be stable X.Y.Z, got ${JSON.stringify(value)}`);
  return match.slice(1).map(BigInt);
}

function compare(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}

export function selectNewestStableRelease({currentVersion, releases}) {
  const current = parts(currentVersion, STABLE_VERSION, "currentVersion");
  if (!Array.isArray(releases)) throw new Error("releases must be an array");
  return releases
    .filter((release) => release && release.draft === false && release.prerelease === false)
    .map((release) => ({release, version: STABLE_TAG.exec(String(release.tag_name ?? ""))}))
    .filter(({version}) => version && compare(version.slice(1).map(BigInt), current) > 0)
    .sort((left, right) => compare(
      right.version.slice(1).map(BigInt),
      left.version.slice(1).map(BigInt),
    ))
    .map(({release}) => release)[0] ?? null;
}

export function verifyUpstreamRelease({tag, tagCommit, release, npm}) {
  const tagParts = parts(tag, STABLE_TAG, "tag");
  const version = tagParts.join(".");
  if (!FULL_COMMIT.test(String(tagCommit ?? ""))) {
    throw new Error(`tagCommit must be a full commit SHA, got ${JSON.stringify(tagCommit)}`);
  }
  if (!release || release.tag_name !== tag) {
    throw new Error(`GitHub release tag ${JSON.stringify(release?.tag_name)} does not match ${tag}`);
  }
  if (release.draft !== false) throw new Error(`GitHub release ${tag} is draft`);
  if (release.prerelease !== false) throw new Error(`GitHub release ${tag} is prerelease`);
  if (npm?.version !== version) {
    throw new Error(`npm latest ${JSON.stringify(npm?.version)} does not match ${version}`);
  }
  if (npm.gitHead != null && npm.gitHead !== "" && npm.gitHead !== tagCommit) {
    throw new Error(`npm gitHead ${npm.gitHead} does not match ${tag} commit ${tagCommit}`);
  }
  return {tag, version, commit: tagCommit};
}
