// Split functions for the tuning harness. All operate on label records that carry
// a `.group` (the unit that must stay together — e.g. an article, or a doc-family
// across versions) and a stratify key (default `product`).
//
//   - holdoutGroups        : grouped + stratified train/test split
//   - kfoldGroups          : grouped + stratified K-fold (GroupKFold)
//   - leaveOneGroupOut     : one fold per stratum value (e.g. leave-one-product-out)
//
// Splitting by GROUP (not by row) prevents leakage: a KB article's title-query and
// its keyword-query never straddle train/test. Stratifying by product keeps the
// folds from being dominated by the few products with huge KBs (auditor, etc).

import { rng, shuffle, hashStr } from './rng.mjs';

// group -> { stratum, idxs:[recordIndex...] }. A group's stratum is taken from its first row.
function groupInfo(records, stratifyBy) {
  const gi = new Map();
  records.forEach((r, i) => {
    const g = r.group;
    if (!gi.has(g)) gi.set(g, { stratum: stratifyBy ? r[stratifyBy] : '_', idxs: [] });
    gi.get(g).idxs.push(i);
  });
  return gi;
}

function byStratum(gi) {
  const m = new Map();
  for (const [g, info] of gi) {
    if (!m.has(info.stratum)) m.set(info.stratum, []);
    m.get(info.stratum).push(g);
  }
  return m;
}

// Assign whole groups to K folds, round-robin within each stratum (so every fold
// gets a balanced product mix). Returns K arrays of record indices.
export function kfoldGroups(records, { k = 5, stratifyBy = 'product', seed = 1 } = {}) {
  const strata = byStratum(groupInfo(records, stratifyBy));
  const foldOfGroup = new Map();
  for (const [stratum, groups] of strata) {
    const sh = shuffle(groups, rng(seed ^ hashStr(stratum)));
    sh.forEach((g, i) => foldOfGroup.set(g, i % k));
  }
  const folds = Array.from({ length: k }, () => []);
  records.forEach((r, i) => folds[foldOfGroup.get(r.group)].push(i));
  return folds;
}

// Grouped + stratified train/test split. Returns { train:[idx], test:[idx] }.
export function holdoutGroups(records, { testFrac = 0.3, stratifyBy = 'product', seed = 1 } = {}) {
  const strata = byStratum(groupInfo(records, stratifyBy));
  const testGroups = new Set();
  for (const [stratum, groups] of strata) {
    const sh = shuffle(groups, rng(seed ^ hashStr(stratum)));
    const nTest = Math.max(1, Math.round(sh.length * testFrac));
    for (let i = 0; i < nTest; i++) testGroups.add(sh[i]);
  }
  const train = [];
  const test = [];
  records.forEach((r, i) => (testGroups.has(r.group) ? test : train).push(i));
  return { train, test };
}

// One fold per distinct value of `by` (default product): test = that value's rows,
// train = the rest. The honest "does this config generalize to a product I never
// tuned on" check. Returns [{ name, train:[idx], test:[idx] }].
export function leaveOneGroupOut(records, { by = 'product' } = {}) {
  const values = [...new Set(records.map((r) => r[by]))].sort();
  return values.map((v) => {
    const train = [];
    const test = [];
    records.forEach((r, i) => (r[by] === v ? test : train).push(i));
    return { name: v, train, test };
  });
}

export default { kfoldGroups, holdoutGroups, leaveOneGroupOut };
