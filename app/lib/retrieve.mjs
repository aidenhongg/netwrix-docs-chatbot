// Retrieval primitives over the per-level vector stores.
//
//   retrieve(query, {level})   - semantic search at chunk | doc | heading granularity
//   similar(nodeId)            - nearest nodes to an existing node in its own space
//
// Both are tier-aware: KB and regular docs are kept separate by default so the
// Knowledge Base behaves as its own layer; pass a tier filter / crossTier to bridge.

import { VectorStore } from './store.mjs';
import { embedQuery, resolveEmbedConfig } from './embeddings.mjs';

const _stores = {};
function store(level) {
  if (!_stores[level]) {
    if (!VectorStore.exists(level))
      throw new Error(
        `No '${level}' vectors. Build them: node ndx.mjs build  (or: node ndx.mjs embed --levels ${level})`
      );
    _stores[level] = VectorStore.load(level);
  }
  return _stores[level];
}

// Map a node id to the embedding level that holds its vector.
export function levelForNode(id = '') {
  if (id.startsWith('chunk:')) return 'chunk';
  if (id.startsWith('head:')) return 'heading';
  if (id.startsWith('doc:') || id.startsWith('kb:')) return 'doc';
  return null;
}

// Semantic search. level: chunk (passages) | doc (whole docs/KB) | heading (sections).
export async function retrieve(query, { level = 'chunk', k = 8, tier = null, product = null } = {}) {
  const s = store(level);
  const cfg = resolveEmbedConfig({ provider: s.provider, model: s.model });
  const qv = await embedQuery(query, cfg);
  const filter =
    tier || product ? (m) => (!tier || m.tier === tier) && (!product || m.product === product) : null;
  return s.search(qv, k, filter);
}

// Nearest nodes to an existing node, in that node's own embedding space.
// Tier-aware: stays within the node's tier by default (KB↔KB, docs↔docs).
// crossTier bridges the two (e.g. the KB articles most similar to a doc).
export function similar(nodeId, { k = 8, crossTier = false, product = null, level = null } = {}) {
  level = level || levelForNode(nodeId);
  if (!level) throw new Error(`Can't infer level from node id "${nodeId}". Use --level chunk|doc|heading.`);
  const s = store(level);
  const self = s.getById(nodeId);
  if (!self) throw new Error(`No ${level}-level vector for "${nodeId}". Is that node embedded at this level?`);
  const myTier = self.meta.tier;
  const filter = (m) =>
    m.id !== nodeId && (crossTier || !myTier || m.tier === myTier) && (!product || m.product === product);
  return s.search(self.vector, k, filter);
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

export default { retrieve, similar, buildContext, levelForNode };
