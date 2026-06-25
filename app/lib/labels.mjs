// Build a labeled (query -> gold node) dataset from the KB (and optionally docs),
// for tuning/evaluating the ranking function. Everything is derived from artifacts
// we already built (graph.json + emb/heading.jsonl) — no re-parsing of source files.
//
// Targets / gold:
//   target=kb,  gold=self : query from a KB article's own fields -> gold = that KB article   (DEFAULT)
//   target=kb,  gold=link : query from a KB article -> gold = the doc(s) it LINKS_TO (sparse here)
//   target=doc            : query from a doc's title/headings -> gold = that doc (docs-base slice)
//
// Each KB article yields several queries (title, description, keywords, tags, symptom).
// They share a `group` (the article) so splits never put one article's queries on
// both sides — and we report per-field so leaky fields (title/keywords) are visible.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Graph } from './graph.mjs';
import { paths, embPaths, OUT_DIR } from '../config.mjs';

// Strip the version segment so cross-version doc twins share a group: doc:auditor@10.6/x -> doc:auditor/x
const docFamily = (id) => id.replace(/@[^/]+\//, '/');

export const labelsPath = (target) => join(OUT_DIR, `labels.${target}.jsonl`);

// Map KB article id -> its "Symptom"-style section body (a realistic user-phrased query).
function symptomMap() {
  const p = embPaths('heading');
  const m = new Map();
  if (!existsSync(p.jsonl)) return m;
  for (const line of readFileSync(p.jsonl, 'utf8').split('\n')) {
    if (!line) continue;
    const it = JSON.parse(line);
    if (it.tier !== 'kb') continue;
    if (!/^(symptom|symptoms|issue|problem|question)\b/i.test(it.label || '')) continue;
    const kbId = it.id.slice('head:'.length).split('#')[0];
    if (m.has(kbId)) continue;
    const body = String(it.text || '').split('\n').slice(1).join(' ').replace(/\s+/g, ' ').trim();
    if (body) m.set(kbId, body.slice(0, 600));
  }
  return m;
}

export function buildLabels({
  target = 'kb',
  gold = 'self',
  queryFields = ['title', 'description', 'keywords', 'symptom'],
  product = null,
} = {}) {
  const g = Graph.load(paths.graph);
  const want = new Set(queryFields);
  const symptoms = target === 'kb' && want.has('symptom') ? symptomMap() : new Map();
  const records = [];

  const add = (query, field, golds, group, prod, tier) => {
    query = String(query || '').replace(/\s+/g, ' ').trim();
    if (!query || !golds.length) return;
    records.push({
      qid: `${records.length}:${field}:${group}`,
      query,
      field,
      golds,
      group,
      product: prod || '?',
      targetTier: tier,
    });
  };

  if (target === 'kb') {
    for (const n of g.nodes.values()) {
      if (n.type !== 'KBArticle') continue;
      const prod = n.productId || '?';
      if (product && prod !== product) continue;

      let golds, tier;
      if (gold === 'link') {
        golds = g
          .neighbors(n.id, { dir: 'out', rel: 'LINKS_TO' })
          .map((e) => e.id)
          .filter((id) => g.get(id) && g.get(id).type === 'Document');
        if (!golds.length) continue;
        tier = 'docs';
      } else {
        golds = [n.id];
        tier = 'kb';
      }
      const group = n.id;

      const kws = g.neighbors(n.id, { dir: 'out', rel: 'MENTIONS' }).map((e) => g.get(e.id)?.label).filter(Boolean);
      const tags = g.neighbors(n.id, { dir: 'out', rel: 'TAGGED' }).map((e) => g.get(e.id)?.label).filter(Boolean);
      if (want.has('title')) add(n.label, 'title', golds, group, prod, tier);
      if (want.has('description')) add(n.description, 'description', golds, group, prod, tier);
      if (want.has('keywords') && kws.length) add(kws.join(' '), 'keywords', golds, group, prod, tier);
      if (want.has('tags') && tags.length) add(tags.join(' '), 'tags', golds, group, prod, tier);
      if (want.has('symptom') && symptoms.has(n.id)) add(symptoms.get(n.id), 'symptom', golds, group, prod, tier);
    }
  } else if (target === 'doc') {
    for (const n of g.nodes.values()) {
      if (n.type !== 'Document') continue;
      const prod = n.productId || '?';
      if (product && prod !== product) continue;
      const group = docFamily(n.id);
      const golds = [n.id];
      if (want.has('title')) add(n.label, 'title', golds, group, prod, 'docs');
      if (want.has('headings') || want.has('heading')) {
        for (const e of g.neighbors(n.id, { dir: 'out', rel: 'HAS_HEADING' })) {
          const h = g.get(e.id);
          if (h && h.label) add(h.label, 'heading', golds, group, prod, 'docs');
        }
      }
    }
  } else {
    throw new Error(`Unknown label target: ${target}`);
  }
  return records;
}

export function saveLabels(records, target) {
  const path = labelsPath(target);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return path;
}

export function loadLabelsFile(path) {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export function labelStats(records) {
  const byProduct = {};
  const byField = {};
  const groups = new Set();
  for (const r of records) {
    byProduct[r.product] = (byProduct[r.product] || 0) + 1;
    byField[r.field] = (byField[r.field] || 0) + 1;
    groups.add(r.group);
  }
  return { records: records.length, groups: groups.size, byProduct, byField };
}

export default { buildLabels, saveLabels, loadLabelsFile, labelStats, labelsPath };
