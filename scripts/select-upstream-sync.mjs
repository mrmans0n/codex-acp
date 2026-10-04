const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function selectUpstreamSync({ tags, openHeads }) {
  const stable = tags
    .map((tag) => typeof tag === "string" ? { name: tag, merged: false } : tag)
    .filter((tag) => STABLE_TAG.test(tag.name))
    .sort((a, b) => {
      const left = STABLE_TAG.exec(a.name).slice(1).map(BigInt);
      const right = STABLE_TAG.exec(b.name).slice(1).map(BigInt);
      for (let i = 0; i < 3; i++) {
        if (left[i] !== right[i]) return left[i] > right[i] ? -1 : 1;
      }
      return 0;
    });
  const newest = stable[0];
  if (!newest || newest.merged) return null;
  const branch = `sync/upstream-${newest.name.slice(1)}`;
  return {
    tag: newest.name,
    branch,
    staleHeads: [...new Set(openHeads)].filter((head) =>
      head !== branch && STABLE_TAG.test(head.replace(/^sync\/upstream-/, "v")) &&
      head.startsWith("sync/upstream-")),
  };
}
