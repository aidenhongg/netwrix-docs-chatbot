// The tunable ranking function. A ranking config is:
//
//   { level:  chunk | doc | heading,     // which embedding space to search
//     signal: vector | bm25 | linear | rrf,  // how to combine vector + lexical
//     alpha,                             // linear: weight on the (normalized) vector score
//     rrfK,                              // rrf: reciprocal-rank-fusion constant
//     pool:   max | mean | sum,          // item -> node score when level != node level
//     candN }                            // candidates pulled from each signal before fusing
//
// Candidates are gathered once per (query, level) and cached; configs that share a
// level re-fuse the same candidates cheaply, so a grid sweep stays fast.

import { VectorStore, readItems } from './store.mjs';
import { BM25 } from './bm25.mjs';
import { embedQuery, resolveEmbedConfig } from './embeddings.mjs';

const _idx = {}; // level -> { store, cfg, bm }
export function indexes(level, { bm25 = true } = {}) {
  if (!_idx[level]) {
    const store = VectorStore.load(level);
    const cfg = resolveEmbedConfig({ provider: store.provider, model: store.model });
    const bm = bm25 ? new BM25(readItems(level).map((it) => ({ id: it.id, text: it.text }))) : null;
    _idx[level] = { store, cfg, bm };
  }
  return _idx[level];
}

// Map an item id at a level to the node (doc/KB article) id used for gold comparison.
export function nodeOfItem(level, id) {
  if (level === 'chunk') return id.slice(6).replace(/#\d+$/, ''); // chunk:<docId>#i
  if (level === 'heading') return id.slice(5).split('#')[0]; // head:<docId>#slug
  return id; // doc level: id is the node id
}

// Pull top candidates from each signal for one (query, level). Returns
// { vec:[{id,score,rank}], bm:[{id,score,rank}] }.
export async function gather(query, level, candN = 200) {
  const ix = indexes(level);
  const qv = await embedQuery(query, ix.cfg);
  const vec = ix.store.search(qv, candN).map((h, r) => ({ id: h.id, score: h.score, rank: r + 1 }));
  const bm = ix.bm ? ix.bm.search(query, candN).map((h, r) => ({ id: h.id, score: h.score, rank: r + 1 })) : [];
  return { vec, bm };
}

const minmax = (vals) => {
  if (!vals.length) return () => 0;
  let mn = Infinity;
  let mx = -Infinity;
  for (const v of vals) {
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const d = mx - mn || 1;
  return (v) => (v == null ? 0 : (v - mn) / d);
};

// Apply a config to gathered candidates -> ranked node ids (best first).
export function rankFrom(cand, level, config, topK = 100) {
  const { signal = 'rrf', alpha = 0.5, rrfK = 60, pool = 'max' } = config;
  const items = new Map(); // itemId -> { vScore, vRank, bScore, bRank }
  for (const c of cand.vec) {
    const o = items.get(c.id) || {};
    o.vScore = c.score;
    o.vRank = c.rank;
    items.set(c.id, o);
  }
  for (const c of cand.bm) {
    const o = items.get(c.id) || {};
    o.bScore = c.score;
    o.bRank = c.rank;
    items.set(c.id, o);
  }

  const nv = minmax([...items.values()].filter((o) => o.vScore != null).map((o) => o.vScore));
  const nb = minmax([...items.values()].filter((o) => o.bScore != null).map((o) => o.bScore));
  const scoreOf = (o) => {
    switch (signal) {
      case 'vector':
        return o.vScore != null ? o.vScore : null;
      case 'bm25':
        return o.bScore != null ? o.bScore : null;
      case 'linear':
        return alpha * nv(o.vScore) + (1 - alpha) * nb(o.bScore);
      case 'rrf':
      default:
        return (o.vRank ? 1 / (rrfK + o.vRank) : 0) + (o.bRank ? 1 / (rrfK + o.bRank) : 0);
    }
  };

  // pool item scores up to the node level
  const nodes = new Map(); // node -> { max, sum, cnt }
  for (const [id, o] of items) {
    const s = scoreOf(o);
    if (s == null) continue;
    const node = nodeOfItem(level, id);
    const cur = nodes.get(node);
    if (!cur) nodes.set(node, { max: s, sum: s, cnt: 1 });
    else {
      cur.max = Math.max(cur.max, s);
      cur.sum += s;
      cur.cnt++;
    }
  }
  const ranked = [...nodes.entries()].map(([node, v]) => ({
    node,
    score: pool === 'mean' ? v.sum / v.cnt : pool === 'sum' ? v.sum : v.max,
  }));
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, topK).map((r) => r.node);
}

export default { indexes, gather, rankFrom, nodeOfItem };
