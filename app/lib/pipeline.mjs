// Build orchestration: embed the chunk corpus, and the full ingest+embed build.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { paths } from '../config.mjs';
import { readChunks, VectorStore } from './store.mjs';
import { resolveEmbedConfig, embedBatch } from './embeddings.mjs';
import { runIngest } from './ingest.mjs';
import { log, progress, progressDone, fmtInt } from './log.mjs';

// Embed chunks.jsonl -> vectors.f32 (+ vectors.meta.json), update manifest.
export async function runEmbed(over = {}) {
  const cfg = resolveEmbedConfig(over);
  const chunks = readChunks();
  if (chunks.length === 0) throw new Error('No chunks to embed. Run `ndx ingest` first.');

  log(`embedding ${fmtInt(chunks.length)} chunks via ${cfg.provider}:${cfg.model}`);
  let dim = cfg.dim;
  let vectors = null;
  for (let i = 0; i < chunks.length; i += cfg.batchSize) {
    const batch = chunks.slice(i, i + cfg.batchSize).map((c) => c.text);
    const vecs = await embedBatch(batch, cfg, 'document');
    if (!vectors) {
      dim = vecs[0].length; // trust the model's actual dimensionality
      vectors = new Float32Array(chunks.length * dim);
    }
    vecs.forEach((v, j) => vectors.set(v, (i + j) * dim));
    progress(`embedded ${fmtInt(Math.min(i + batch.length, chunks.length))}/${fmtInt(chunks.length)}…`);
  }
  progressDone();

  cfg.dim = dim;
  VectorStore.save(vectors, chunks.length, dim, cfg);
  log(`wrote ${fmtInt(chunks.length)} vectors (${dim}d) -> ${paths.vectors}`);

  // annotate the manifest with the embedding model used
  if (existsSync(paths.manifest)) {
    try {
      const m = JSON.parse(readFileSync(paths.manifest, 'utf8'));
      m.embedding = { provider: cfg.provider, model: cfg.model, dim, count: chunks.length };
      writeFileSync(paths.manifest, JSON.stringify(m, null, 2));
    } catch {
      /* non-fatal */
    }
  }
  return { count: chunks.length, dim, provider: cfg.provider, model: cfg.model };
}

// Full build: ingest then embed.
export async function runBuild({ embed = {}, ...ingestOpts } = {}) {
  const ing = await runIngest(ingestOpts);
  const emb = await runEmbed(embed);
  return { ing, emb };
}

export default { runEmbed, runBuild };
