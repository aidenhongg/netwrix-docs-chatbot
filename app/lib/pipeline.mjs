// Build orchestration: embed each level's item corpus, and the full ingest+embed build.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { paths, LEVELS, embPaths } from '../config.mjs';
import { readItems, VectorStore } from './store.mjs';
import { resolveEmbedConfig, embedBatch } from './embeddings.mjs';
import { runIngest } from './ingest.mjs';
import { log, progress, progressDone, fmtInt } from './log.mjs';

async function embedLevel(level, cfg) {
  const items = readItems(level);
  if (!items.length) return null;
  log(`embedding ${level}: ${fmtInt(items.length)} items via ${cfg.provider}:${cfg.model}`);
  let dim = cfg.dim;
  let vectors = null;
  for (let i = 0; i < items.length; i += cfg.batchSize) {
    const batch = items.slice(i, i + cfg.batchSize).map((it) => it.text);
    const vecs = await embedBatch(batch, cfg, 'document');
    if (!vectors) {
      dim = vecs[0].length; // trust the model's actual dimensionality
      vectors = new Float32Array(items.length * dim);
    }
    vecs.forEach((v, j) => vectors.set(v, (i + j) * dim));
    progress(`  ${level}: ${fmtInt(Math.min(i + batch.length, items.length))}/${fmtInt(items.length)}…`);
  }
  progressDone();
  VectorStore.saveVectors(level, vectors, items.length, dim, cfg);
  return { count: items.length, dim };
}

// Embed the requested levels (default: all that have an item corpus on disk).
export async function runEmbed({ levels, ...over } = {}) {
  const cfg = resolveEmbedConfig(over);
  const targets = (levels && levels.length ? levels : LEVELS).filter((l) => existsSync(embPaths(l).jsonl));
  if (!targets.length) throw new Error('No item corpora to embed. Run `ndx ingest` first.');

  const byLevel = {};
  for (const level of targets) {
    const r = await embedLevel(level, cfg);
    if (r) byLevel[level] = r;
  }

  if (existsSync(paths.manifest)) {
    try {
      const m = JSON.parse(readFileSync(paths.manifest, 'utf8'));
      m.embedding = { provider: cfg.provider, model: cfg.model, byLevel };
      m.levels = m.levels || {};
      for (const [lvl, info] of Object.entries(byLevel)) {
        m.levels[lvl] = { items: (m.levels[lvl] && m.levels[lvl].items) || info.count, dim: info.dim, vectors: info.count };
      }
      writeFileSync(paths.manifest, JSON.stringify(m, null, 2));
    } catch {
      /* non-fatal */
    }
  }
  log(`embedded: ${Object.entries(byLevel).map(([l, r]) => `${l}=${fmtInt(r.count)}`).join(', ')} (${cfg.provider}:${cfg.model})`);
  return { provider: cfg.provider, model: cfg.model, byLevel };
}

// Full build: ingest then embed all levels.
export async function runBuild({ embed = {}, ...ingestOpts } = {}) {
  const ing = await runIngest(ingestOpts);
  const emb = await runEmbed(embed);
  return { ing, emb };
}

export default { runEmbed, runBuild };
