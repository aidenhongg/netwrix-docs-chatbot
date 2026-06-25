// Flat-file vector store, one per embedding "level" (chunk | doc | heading).
// Every item is keyed by its graph node id, so any node type becomes
// semantically searchable / clusterable without bloating graph.json.
//
//   emb/<level>.jsonl      - one item record per line (id, type, tier, …, text)
//   emb/<level>.f32        - packed little-endian Float32, N*dim, aligned to jsonl
//   emb/<level>.meta.json  - { provider, model, dim, count, level }
//
// Search is a brute-force dot product (vectors are normalized). For ~100k items
// this is milliseconds in Node and keeps the system dependency-free and portable.

import {
  readFileSync, writeFileSync, openSync, writeSync, closeSync, existsSync, mkdirSync,
} from 'node:fs';
import { embPaths, EMB_DIR } from '../config.mjs';

export class VectorStore {
  constructor(level, dim) {
    this.level = level;
    this.dim = dim;
    this.vectors = null; // Float32Array (count*dim)
    this.metas = []; // item metadata records (parsed from <level>.jsonl)
    this.count = 0;
    this.idIndex = new Map(); // node id -> row index (for `similar`)
  }

  static exists(level) {
    const p = embPaths(level);
    return existsSync(p.vectors) && existsSync(p.meta) && existsSync(p.jsonl);
  }

  static load(level) {
    const p = embPaths(level);
    const meta = JSON.parse(readFileSync(p.meta, 'utf8'));
    const store = new VectorStore(level, meta.dim);
    store.provider = meta.provider;
    store.model = meta.model;

    const buf = readFileSync(p.vectors);
    store.vectors = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    store.count = store.vectors.length / meta.dim;

    store.metas = readFileSync(p.jsonl, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    if (store.metas.length !== store.count) {
      throw new Error(
        `Vector/item mismatch for '${level}': ${store.count} vectors vs ${store.metas.length} items. Rebuild with 'ndx build'.`
      );
    }
    store.metas.forEach((m, i) => store.idIndex.set(m.id, i));
    return store;
  }

  // Save vectors aligned to an existing <level>.jsonl (which ingest already wrote).
  static saveVectors(level, vectors, count, dim, providerInfo) {
    mkdirSync(EMB_DIR, { recursive: true });
    const p = embPaths(level);
    writeFileSync(p.vectors, Buffer.from(vectors.buffer, vectors.byteOffset, count * dim * 4));
    writeFileSync(
      p.meta,
      JSON.stringify(
        { provider: providerInfo.provider, model: providerInfo.model, dim, count, level },
        null,
        2
      )
    );
  }

  // Look up a stored node's own vector (for similarity / nearest-neighbour queries).
  getById(id) {
    const i = this.idIndex.get(id);
    if (i === undefined) return null;
    return { index: i, meta: this.metas[i], vector: this.vectors.subarray(i * this.dim, (i + 1) * this.dim) };
  }

  // Top-k by cosine (dot product on normalized vectors), with optional filter.
  search(queryVec, k = 8, filter = null) {
    const { vectors, dim, count, metas } = this;
    const scores = [];
    for (let i = 0; i < count; i++) {
      if (filter && !filter(metas[i])) continue;
      let s = 0;
      const off = i * dim;
      for (let d = 0; d < dim; d++) s += vectors[off + d] * queryVec[d];
      scores.push([i, s]);
    }
    scores.sort((a, b) => b[1] - a[1]);
    return scores.slice(0, k).map(([i, s]) => ({ score: s, ...metas[i] }));
  }
}

// Stream item records to emb/<level>.jsonl during ingestion (no full-corpus buffering).
export function openItemWriter(level) {
  mkdirSync(EMB_DIR, { recursive: true });
  const fd = openSync(embPaths(level).jsonl, 'w');
  let n = 0;
  return {
    write(rec) {
      writeSync(fd, JSON.stringify(rec) + '\n');
      n++;
    },
    get count() {
      return n;
    },
    close() {
      closeSync(fd);
      return n;
    },
  };
}

// Read an item corpus back (used by `embed`).
export function readItems(level) {
  const p = embPaths(level);
  if (!existsSync(p.jsonl)) throw new Error(`No '${level}' items at ${p.jsonl}. Run 'ndx ingest' first.`);
  return readFileSync(p.jsonl, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export default { VectorStore, openItemWriter, readItems };
