// Community detection over node vectors: greedy connected components over cosine
// edges above `threshold` (union-find). Operates on any embedding level.
//
// Tier-aware: filter to one tier so KB clusters separately from regular docs.
// O(n^2 · dim) — fine within a product/tier; `cap` guards against accidentally
// clustering the entire base (narrow with --product / --tier).

import { VectorStore } from './store.mjs';

export function cluster({ level = 'doc', tier = null, product = null, threshold = 0.55, cap = 2500, top = 25 } = {}) {
  if (!VectorStore.exists(level)) throw new Error(`No '${level}' vectors. Build them first: node ndx.mjs build`);
  const s = VectorStore.load(level);

  const idx = [];
  for (let i = 0; i < s.count; i++) {
    const m = s.metas[i];
    if ((!tier || m.tier === tier) && (!product || m.product === product)) idx.push(i);
  }
  if (idx.length === 0) return { n: 0, clusters: [], singletons: 0 };
  if (idx.length > cap)
    throw new Error(
      `${idx.length} ${level} nodes match — too many to cluster (cap ${cap}). Narrow with --product and/or --tier.`
    );

  const { dim, vectors: V } = s;
  const parent = idx.map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[a] = b;
  };

  for (let a = 0; a < idx.length; a++) {
    const oa = idx[a] * dim;
    for (let b = a + 1; b < idx.length; b++) {
      const ob = idx[b] * dim;
      let dot = 0;
      for (let d = 0; d < dim; d++) dot += V[oa + d] * V[ob + d];
      if (dot >= threshold) union(a, b);
    }
  }

  const groups = new Map();
  idx.forEach((orig, a) => {
    const r = find(a);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(s.metas[orig]);
  });
  const all = [...groups.values()];
  const clusters = all
    .filter((g) => g.length > 1)
    .sort((a, b) => b.length - a.length)
    .slice(0, top)
    .map((members) => ({
      size: members.length,
      label: members[0].label,
      members: members.slice(0, 10).map((m) => ({ id: m.id, label: m.label, tier: m.tier, product: m.product, version: m.version })),
    }));
  return { n: idx.length, clusters, singletons: all.filter((g) => g.length === 1).length };
}

export default { cluster };
