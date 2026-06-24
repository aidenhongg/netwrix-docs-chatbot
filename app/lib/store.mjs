// Flat-file vector store. Designed to be cheap to build and trivial to inspect.
//
//   chunks.jsonl    - one JSON record per chunk (id, doc ref, metadata, text)
//   vectors.f32     - packed little-endian Float32, N * dim, aligned to chunks.jsonl order
//   vectors.meta.json - { provider, model, dim, count }
//
// Search is a brute-force dot product (vectors are normalized). For ~100k chunks
// this is milliseconds in Node and keeps the system dependency-free and portable.

import { readFileSync, writeFileSync, openSync, writeSync, closeSync, existsSync } from 'node:fs';
import { paths } from '../config.mjs';

export class VectorStore {
  constructor(dim) {
    this.dim = dim;
    this.vectors = null; // Float32Array (count*dim)
    this.metas = []; // chunk metadata records (parsed from chunks.jsonl)
    this.count = 0;
  }

  static exists() {
    return existsSync(paths.vectors) && existsSync(paths.vectorsMeta) && existsSync(paths.chunks);
  }

  static load() {
    const meta = JSON.parse(readFileSync(paths.vectorsMeta, 'utf8'));
    const store = new VectorStore(meta.dim);
    store.provider = meta.provider;
    store.model = meta.model;

    const buf = readFileSync(paths.vectors);
    store.vectors = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    store.count = store.vectors.length / meta.dim;

    const lines = readFileSync(paths.chunks, 'utf8').split('\n').filter(Boolean);
    store.metas = lines.map((l) => JSON.parse(l));
    if (store.metas.length !== store.count) {
      throw new Error(
        `Vector/chunk count mismatch: ${store.count} vectors vs ${store.metas.length} chunks. Rebuild with 'ndx build'.`
      );
    }
    return store;
  }

  // Save vectors aligned to an existing chunks.jsonl (which ingest already wrote).
  static save(vectors, count, dim, providerInfo) {
    const buf = Buffer.from(vectors.buffer, vectors.byteOffset, count * dim * 4);
    writeFileSync(paths.vectors, buf);
    writeFileSync(
      paths.vectorsMeta,
      JSON.stringify({ provider: providerInfo.provider, model: providerInfo.model, dim, count }, null, 2)
    );
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

// Stream chunk records to chunks.jsonl during ingestion without holding them all
// in memory. Returns a writer with .write(record) and .close().
export function openChunkWriter() {
  const fd = openSync(paths.chunks, 'w');
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

// Read chunks.jsonl back (used by `embed`).
export function readChunks() {
  if (!existsSync(paths.chunks)) throw new Error(`No chunks at ${paths.chunks}. Run 'ndx ingest' first.`);
  return readFileSync(paths.chunks, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export default { VectorStore, openChunkWriter, readChunks };
