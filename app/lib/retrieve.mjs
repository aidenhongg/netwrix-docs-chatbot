// Retrieval: embed the query with the SAME provider/model the corpus was built
// with (read from vectors.meta.json), then cosine-search the vector store.
// Optional graph-aware expansion pulls in neighbouring chunks for more context.

import { VectorStore } from './store.mjs';
import { embedQuery, resolveEmbedConfig } from './embeddings.mjs';

let _store = null;
function store() {
  if (!_store) {
    if (!VectorStore.exists())
      throw new Error('No vector store found. Build it first: `node ndx.mjs build`');
    _store = VectorStore.load();
  }
  return _store;
}

export async function retrieve(query, { k = 8, tier = null, product = null } = {}) {
  const s = store();
  const cfg = resolveEmbedConfig({ provider: s.provider, model: s.model });
  const qv = await embedQuery(query, cfg);
  const filter =
    tier || product ? (m) => (!tier || m.tier === tier) && (!product || m.product === product) : null;
  return s.search(qv, k, filter);
}

// Format hits into a numbered context block + a parallel source list for citations.
export function buildContext(hits) {
  const sources = hits.map((h, i) => ({
    n: i + 1,
    ref: h.ref,
    url: h.url,
    tier: h.tier,
    product: h.product,
    version: h.version,
    score: h.score,
  }));
  const text = hits
    .map((h, i) => {
      const where = [h.ref, h.url].filter(Boolean).join('  ');
      return `[${i + 1}] ${where}\n${h.text}`;
    })
    .join('\n\n----------\n\n');
  return { text, sources };
}

export default { retrieve, buildContext };
