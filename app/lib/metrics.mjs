// Information-retrieval metrics over a ranked list of node ids vs. a gold set,
// plus group-aware bootstrap confidence intervals.

import { rng } from './rng.mjs';

// Reciprocal rank of the first relevant result (0 if none in the list).
export function rr(ranked, gold) {
  for (let i = 0; i < ranked.length; i++) if (gold.has(ranked[i])) return 1 / (i + 1);
  return 0;
}

// 1 if any gold appears in the top-k, else 0.
export function hitAtK(ranked, gold, k) {
  const n = Math.min(k, ranked.length);
  for (let i = 0; i < n; i++) if (gold.has(ranked[i])) return 1;
  return 0;
}

// Fraction of the gold set retrieved within the top-k.
export function recallAtK(ranked, gold, k) {
  if (gold.size === 0) return 0;
  const n = Math.min(k, ranked.length);
  let hit = 0;
  for (let i = 0; i < n; i++) if (gold.has(ranked[i])) hit++;
  return hit / gold.size;
}

// Binary-relevance nDCG@k (ideal = all golds ranked first).
export function ndcgAtK(ranked, gold, k) {
  const n = Math.min(k, ranked.length);
  let dcg = 0;
  for (let i = 0; i < n; i++) if (gold.has(ranked[i])) dcg += 1 / Math.log2(i + 2);
  let idcg = 0;
  const ideal = Math.min(k, gold.size);
  for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2);
  return idcg ? dcg / idcg : 0;
}

// The standard bundle we compute per query.
export function metricBundle(ranked, gold) {
  return {
    mrr: rr(ranked, gold),
    'hit@1': hitAtK(ranked, gold, 1),
    'hit@5': hitAtK(ranked, gold, 5),
    'hit@10': hitAtK(ranked, gold, 10),
    'recall@10': recallAtK(ranked, gold, 10),
    'ndcg@10': ndcgAtK(ranked, gold, 10),
  };
}
export const METRIC_KEYS = ['mrr', 'hit@1', 'hit@5', 'hit@10', 'recall@10', 'ndcg@10'];

// Mean of `values` with a bootstrap CI. If `groups` (same length) is given,
// resample whole groups — queries from one article are correlated, so this
// gives honest intervals instead of pretending they're independent.
export function bootstrapCI(values, groups = null, { n = 500, seed = 7, ci = 0.95 } = {}) {
  if (!values.length) return { mean: 0, lo: 0, hi: 0, n: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  let groupList = null;
  if (groups) {
    const map = new Map();
    groups.forEach((g, i) => {
      if (!map.has(g)) map.set(g, []);
      map.get(g).push(i);
    });
    groupList = [...map.values()];
  }
  const rand = rng(seed);
  const means = [];
  for (let b = 0; b < n; b++) {
    let sum = 0;
    let cnt = 0;
    if (groupList) {
      for (let s = 0; s < groupList.length; s++) {
        const grp = groupList[Math.floor(rand() * groupList.length)];
        for (const i of grp) {
          sum += values[i];
          cnt++;
        }
      }
    } else {
      for (let s = 0; s < values.length; s++) {
        sum += values[Math.floor(rand() * values.length)];
        cnt++;
      }
    }
    means.push(sum / Math.max(1, cnt));
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor(((1 - ci) / 2) * n)];
  const hi = means[Math.min(n - 1, Math.floor(((1 + ci) / 2) * n))];
  return { mean, lo, hi, n: values.length };
}

export default { rr, hitAtK, recallAtK, ndcgAtK, metricBundle, bootstrapCI, METRIC_KEYS };
