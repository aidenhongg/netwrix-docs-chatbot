// Central configuration for the ndx documentation chatbot.
//
// Everything is overridable from the environment so it is easy to experiment
// without editing code. The CLI (ndx.mjs) layers per-command flags on top of
// these defaults.

import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const APP_DIR = __dirname;
export const REPO_DIR = resolve(APP_DIR, '..');
// The Docusaurus content root: chatbot/docs/docs/<product>/...
export const DOCS_ROOT = resolve(REPO_DIR, 'docs', 'docs');
// The canonical product manifest that the docs site itself is built from.
export const PRODUCTS_CONFIG = resolve(REPO_DIR, 'docs', 'src', 'config', 'products.js');

export const OUT_DIR = process.env.NDX_OUT ? resolve(process.env.NDX_OUT) : join(APP_DIR, 'out');

export const paths = {
  graph: join(OUT_DIR, 'graph.json'),
  chunks: join(OUT_DIR, 'chunks.jsonl'),
  vectors: join(OUT_DIR, 'vectors.f32'),
  vectorsMeta: join(OUT_DIR, 'vectors.meta.json'),
  manifest: join(OUT_DIR, 'manifest.json'),
};

export const config = {
  paths,
  // --- Chunking (sizes are in characters; ~4 chars ≈ 1 token) ---
  chunk: {
    maxChars: Number(process.env.NDX_CHUNK_CHARS || 1280), // ~320 tokens
    overlapChars: Number(process.env.NDX_CHUNK_OVERLAP || 240), // ~60 tokens
    minChars: 64, // drop near-empty fragments
  },
  // --- Embeddings ---
  embed: {
    // local  : free, on-device MiniLM via @huggingface/transformers (384d)
    // openai : text-embedding-3-small via REST (1536d) — needs OPENAI_API_KEY
    // voyage : voyage-3.5-lite via REST (1024d) — needs VOYAGE_API_KEY
    // hash   : zero-dependency lexical hashing (256d) — offline, instant, for testing
    provider: process.env.NDX_EMBED_PROVIDER || 'local',
    model: process.env.NDX_EMBED_MODEL || '', // '' => provider default
    batchSize: Number(process.env.NDX_EMBED_BATCH || 64),
  },
  // --- Generation (RAG answer) ---
  chat: {
    // Cheap by default; override with NDX_CHAT_MODEL=claude-opus-4-8 for quality.
    model: process.env.NDX_CHAT_MODEL || 'claude-haiku-4-5',
    maxTokens: Number(process.env.NDX_CHAT_MAX_TOKENS || 1024),
    topK: Number(process.env.NDX_TOPK || 8),
  },
};

// ~4 chars per token is a decent estimate for English docs.
export const estTokens = (s) => Math.ceil((s || '').length / 4);

// Filesystem/JSON-safe slug for ids and tags.
export const slug = (s) =>
  String(s)
    .toLowerCase()
    .trim()
    .replace(/[^\w./@-]+/g, '-')
    .replace(/^-+|-+$/g, '');

export default config;
