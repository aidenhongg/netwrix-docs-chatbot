// Pluggable embedding providers. All return L2-normalized Float32Array vectors,
// so cosine similarity is a plain dot product.
//
//   local  : @huggingface/transformers MiniLM (free, on-device, 384d). Lazy-loaded.
//   openai : text-embedding-3-small via REST (1536d). Needs OPENAI_API_KEY.
//   voyage : voyage-3.5-lite via REST (1024d). Needs VOYAGE_API_KEY. (Anthropic-recommended.)
//   hash   : zero-dependency lexical feature hashing (256d). Offline + instant; for testing
//            the pipeline and as a no-key fallback. Lower quality than a real model.

import { config } from '../config.mjs';

const DEFAULT_MODEL = {
  local: 'Xenova/all-MiniLM-L6-v2',
  openai: 'text-embedding-3-small',
  voyage: 'voyage-3.5-lite',
  hash: 'hash-256',
};

export function providerDim(provider, model) {
  if (provider === 'hash') return 256;
  if (provider === 'local') return 384;
  if (provider === 'openai') return /3-large/.test(model || '') ? 3072 : 1536;
  if (provider === 'voyage') return 1024;
  return 384;
}

export function resolveEmbedConfig(over = {}) {
  const provider = over.provider || config.embed.provider;
  const model = over.model || config.embed.model || DEFAULT_MODEL[provider] || '';
  return { provider, model, dim: providerDim(provider, model), batchSize: config.embed.batchSize };
}

function l2normalize(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i] * arr[i];
  s = Math.sqrt(s) || 1;
  for (let i = 0; i < arr.length; i++) arr[i] /= s;
  return arr;
}

// --- hash provider (no deps) ----------------------------------------------

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function hashEmbed(text, dim) {
  const v = new Float32Array(dim);
  const tokens = String(text).toLowerCase().match(/[a-z0-9]+/g) || [];
  for (const tok of tokens) {
    // include the token and a couple of char-ngrams for a little fuzziness
    v[fnv1a(tok) % dim] += 1;
    if (tok.length > 4) {
      v[fnv1a(tok.slice(0, 4)) % dim] += 0.5;
      v[fnv1a(tok.slice(-4)) % dim] += 0.5;
    }
  }
  return l2normalize(v);
}

// --- local provider (@huggingface/transformers) ----------------------------

let _localPipe = null;
async function getLocalPipeline(model) {
  if (_localPipe) return _localPipe;
  let transformers;
  try {
    transformers = await import('@huggingface/transformers');
  } catch {
    try {
      transformers = await import('@xenova/transformers'); // older package name
    } catch (e) {
      throw new Error(
        "Local embeddings need '@huggingface/transformers'. Run `npm install` in app/, " +
          'or use a different provider: NDX_EMBED_PROVIDER=hash|openai|voyage'
      );
    }
  }
  if (transformers.env) transformers.env.allowLocalModels = false;
  _localPipe = await transformers.pipeline('feature-extraction', model);
  return _localPipe;
}

async function localEmbed(texts, model) {
  const pipe = await getLocalPipeline(model);
  const res = await pipe(texts, { pooling: 'mean', normalize: true });
  // res.tolist() => number[][]
  const list = res.tolist ? res.tolist() : res;
  return list.map((row) => Float32Array.from(row));
}

// --- REST providers --------------------------------------------------------

async function openaiEmbed(texts, model) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not set (provider=openai).');
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!r.ok) throw new Error(`OpenAI embeddings ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j.data.sort((a, b) => a.index - b.index).map((d) => l2normalize(Float32Array.from(d.embedding)));
}

async function voyageEmbed(texts, model, inputType = 'document') {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new Error('VOYAGE_API_KEY is not set (provider=voyage).');
  const r = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, input: texts, input_type: inputType }),
  });
  if (!r.ok) throw new Error(`Voyage embeddings ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j.data.sort((a, b) => a.index - b.index).map((d) => l2normalize(Float32Array.from(d.embedding)));
}

// --- public API ------------------------------------------------------------

// Embed an array of strings -> array of Float32Array (normalized).
// inputType only matters for voyage ('document' vs 'query').
export async function embedBatch(texts, cfg, inputType = 'document') {
  const { provider, model, dim } = cfg;
  if (texts.length === 0) return [];
  switch (provider) {
    case 'hash':
      return texts.map((t) => hashEmbed(t, dim));
    case 'local':
      return localEmbed(texts, model);
    case 'openai':
      return openaiEmbed(texts, model);
    case 'voyage':
      return voyageEmbed(texts, model, inputType);
    default:
      throw new Error(`Unknown embedding provider: ${provider}`);
  }
}

// Embed a single query string.
export async function embedQuery(text, cfg) {
  const [v] = await embedBatch([text], cfg, 'query');
  return v;
}

export default { embedBatch, embedQuery, resolveEmbedConfig, providerDim };
