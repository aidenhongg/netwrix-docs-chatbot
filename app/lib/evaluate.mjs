// Evaluation + tuning orchestrator.
//
//   evaluateConfig(records, config)  -> full report for ONE ranking config
//                                       (overall + macro + per-product + per-field, with CIs)
//   tune(records, grid, opts)        -> leaderboard of configs by held-out metric,
//                                       via k-fold CV / holdout / leave-one-product-out
//
// Candidates are gathered once per (query, level) and reused across every config and
// every fold — the ranking of a query doesn't depend on the split, so CV only changes
// which queries are aggregated, never the work.

import { gather, rankFrom } from './rank.mjs';
import { metricBundle, METRIC_KEYS, bootstrapCI } from './metrics.mjs';
import { kfoldGroups, holdoutGroups, leaveOneGroupOut } from './splits.mjs';
import { progress, progressDone, fmtInt } from './log.mjs';

async function gatherAll(records, levels, candN, cache) {
  let done = 0;
  for (const r of records) {
    let c = cache.get(r.qid);
    if (!c) {
      c = {};
      cache.set(r.qid, c);
    }
    for (const level of levels) if (!c[level]) c[level] = await gather(r.query, level, candN);
    if (++done % 500 === 0) progress(`gathering candidates ${fmtInt(done)}/${fmtInt(records.length)}…`);
  }
  progressDone();
}

function perQuery(records, config, cache) {
  return records.map((r) => {
    const cand = cache.get(r.qid)[config.level];
    const ranked = rankFrom(cand, config.level, config, 100);
    return { group: r.group, product: r.product, field: r.field, m: metricBundle(ranked, new Set(r.golds)) };
  });
}

const meanOf = (rows, keys) => {
  const o = {};
  for (const k of keys) o[k] = rows.length ? rows.reduce((a, r) => a + r.m[k], 0) / rows.length : 0;
  return o;
};
const meanMetric = (rows, metric) => (rows.length ? rows.reduce((a, r) => a + r.m[metric], 0) / rows.length : 0);
const mean1 = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const std1 = (a) => {
  if (a.length < 2) return 0;
  const m = mean1(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

function aggregate(rows) {
  const groups = rows.map((r) => r.group);
  const overall = {};
  for (const k of METRIC_KEYS) overall[k] = bootstrapCI(rows.map((r) => r.m[k]), groups);

  const byKey = (key) => {
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r[key])) map.set(r[key], []);
      map.get(r[key]).push(r);
    }
    return [...map.entries()].map(([v, rs]) => ({ [key]: v, n: rs.length, ...meanOf(rs, METRIC_KEYS) }));
  };
  const perProduct = byKey('product').sort((a, b) => b.mrr - a.mrr);
  const byField = byKey('field').sort((a, b) => b.n - a.n);
  const macro = {};
  for (const k of METRIC_KEYS) macro[k] = perProduct.length ? perProduct.reduce((a, p) => a + p[k], 0) / perProduct.length : 0;
  return { n: rows.length, overall, macro, perProduct, byField };
}

export async function evaluateConfig(records, config, { candN = 200 } = {}) {
  const cache = new Map();
  await gatherAll(records, [config.level], candN, cache);
  return aggregate(perQuery(records, config, cache));
}

export function configKey(c) {
  const pool = c.level === 'doc' ? '' : `/${c.pool}`;
  return `${c.level}/${c.signal}${c.signal === 'linear' ? '@' + c.alpha : ''}${pool}`;
}

export function expandGrid(grid) {
  const levels = grid.levels || ['doc'];
  const signals = grid.signals || ['vector', 'bm25', 'rrf'];
  const pools = grid.pools || ['max'];
  const alphas = grid.alphas || [0.5];
  const rrfK = grid.rrfK || 60;
  const candN = grid.candN || 200;
  const seen = new Set();
  const configs = [];
  for (const level of levels)
    for (const signal of signals)
      for (const poolRaw of pools) {
        const pool = level === 'doc' ? 'max' : poolRaw; // one item per node at doc level
        const variants = signal === 'linear' ? alphas.map((alpha) => ({ alpha })) : [{}];
        for (const v of variants) {
          const c = { level, signal, pool, rrfK, candN, ...v };
          const key = configKey(c);
          if (!seen.has(key)) {
            seen.add(key);
            configs.push(c);
          }
        }
      }
  return configs;
}

export async function tune(records, grid, opts = {}) {
  const { metric = 'mrr', cv = 5, holdout = 0, lopo = false, finalHoldout = 0, stratifyBy = 'product', seed = 1 } = opts;
  if (!METRIC_KEYS.includes(metric)) throw new Error(`Unknown --metric ${metric}. Options: ${METRIC_KEYS.join(', ')}`);
  const candN = opts.candN || grid.candN || 200;
  const configs = expandGrid({ ...grid, candN });
  const levels = [...new Set(configs.map((c) => c.level))];

  // carve a final holdout first (never used for selection)
  let pool = records;
  let finalTest = null;
  if (finalHoldout > 0) {
    const { train, test } = holdoutGroups(records, { testFrac: finalHoldout, stratifyBy, seed });
    pool = train.map((i) => records[i]);
    finalTest = test.map((i) => records[i]);
  }

  const cache = new Map();
  await gatherAll([...pool, ...(finalTest || [])], levels, candN, cache);

  // evaluation folds over the selection pool
  let folds;
  let scheme;
  if (lopo) {
    folds = leaveOneGroupOut(pool, { by: stratifyBy }).map((f) => ({ name: f.name, idx: f.test }));
    scheme = `leave-one-${stratifyBy}-out`;
  } else if (holdout > 0) {
    folds = [{ name: 'holdout', idx: holdoutGroups(pool, { testFrac: holdout, stratifyBy, seed }).test }];
    scheme = `grouped holdout (test=${holdout})`;
  } else {
    folds = kfoldGroups(pool, { k: cv, stratifyBy, seed }).map((idx, i) => ({ name: `fold${i + 1}`, idx }));
    scheme = `${cv}-fold grouped CV`;
  }

  const leaderboard = [];
  for (const config of configs) {
    const rows = perQuery(pool, config, cache);
    const foldScores = folds.map((f) => meanMetric(f.idx.map((i) => rows[i]), metric));
    leaderboard.push({ config, key: configKey(config), metric: mean1(foldScores), std: std1(foldScores), foldScores });
  }
  leaderboard.sort((a, b) => b.metric - a.metric);

  let finalReport = null;
  if (finalTest) {
    const best = leaderboard[0].config;
    finalReport = { key: configKey(best), report: aggregate(perQuery(finalTest, best, cache)) };
  }
  return {
    leaderboard,
    scheme,
    metric,
    folds: folds.map((f) => ({ name: f.name, n: f.idx.length })),
    n: pool.length,
    configs: configs.length,
    finalReport,
  };
}

export default { evaluateConfig, tune, expandGrid, configKey };
