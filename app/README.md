# ndx — Netwrix Docs Knowledge Graph + RAG Chatbot

A small, dependency-light pipeline that turns the entire Netwrix documentation base
(`../docs/docs`, ~18k markdown files across ~28 products + a Knowledge Base) into:

- a **knowledge graph** (`out/graph.json`) with rich node types,
- an **embeddable chunk corpus** (`out/chunks.jsonl`),
- a **vector store** (`out/vectors.f32`) for semantic search,
- a **manifest** (`out/manifest.json`) describing the transformed base,

and a CLI (`ndx.mjs`) to **search**, **traverse the graph**, and **chat** (RAG) over it.

The core pipeline (ingest → graph → chunks → vectors → retrieval) is **pure Node, zero
dependencies**. Real embedding models and Claude generation are opt-in.

---

## Quick start

```bash
cd app

# 1) Build everything, offline, instantly, on one small product (no installs, no keys):
node ndx.mjs build --product 1secure --provider hash

# 2) Inspect what was built
node ndx.mjs stats
node ndx.mjs manifest

# 3) Semantic search (works with any provider, no API key)
node ndx.mjs search "configure data collection" --product 1secure

# 4) Traverse the graph
node ndx.mjs node product:1secure
node ndx.mjs neighbors kbroot --rel CONTAINS

# 5) Ask a question (needs ANTHROPIC_API_KEY; defaults to cheap claude-haiku-4-5)
export ANTHROPIC_API_KEY=sk-ant-...
node ndx.mjs ask "How do I add a data source in 1Secure?"
```

Drop `--product 1secure` to build the **whole** base.

---

## Commands

```
BUILD
  build      Ingest docs + embed chunks (full pipeline)
  ingest     Build graph + chunk corpus + manifest (no embeddings)
  embed      Embed the chunk corpus into the vector store

INSPECT
  stats      Node/edge/type counts
  manifest   Manifest summary (products, versions, KB counts)
  node <id>  Show a node + neighbours
  neighbors <id>   List neighbours          [--rel R --dir out|in|both]
  path <a> <b>     Shortest path between two nodes

QUERY
  search <query>   Vector search            [-k N --tier docs|kb --product id]
  ask <question>   RAG answer with citations [-k N --tier --product --model M]
  chat             Interactive RAG REPL
```

Common flags: `--product <id>`, `--limit <n>`, `--images`,
`--provider local|openai|voyage|hash`, `--embed-model <name>`, `--model <claude-model>`.

---

## Embedding providers (cheap to free)

Set once with `--provider` or `NDX_EMBED_PROVIDER`. The query is always embedded with the
same provider/model the corpus was built with (recorded in `out/vectors.meta.json`).

| Provider | Model (default)            | Dim  | Cost            | Needs                         |
|----------|----------------------------|------|-----------------|-------------------------------|
| `local`  | `Xenova/all-MiniLM-L6-v2`  | 384  | **free**, on-device | `npm install` (downloads ~90MB model on first run) |
| `voyage` | `voyage-3.5-lite`          | 1024 | ~pennies/base   | `VOYAGE_API_KEY` (Anthropic-recommended) |
| `openai` | `text-embedding-3-small`   | 1536 | ~$0.30 for whole base | `OPENAI_API_KEY`        |
| `hash`   | lexical feature hashing    | 256  | **free**, instant, offline | nothing — good for testing |

Whole-base cost is tiny: ~30–40M tokens → well under **$1** on `openai`/`voyage`, **$0** on
`local`/`hash`. `local` is the recommended default for quality with no API key.

## Generation (the chatbot answer)

Uses Claude via `@anthropic-ai/sdk` (falls back to raw `fetch` if the SDK isn't installed).
Default model is **`claude-haiku-4-5`** (cheap); override with `--model claude-opus-4-8` or
`NDX_CHAT_MODEL`. Needs `ANTHROPIC_API_KEY`. Search and graph commands need no key.

```bash
npm install            # installs @anthropic-ai/sdk + @huggingface/transformers
```

---

## The graph

Node types: `Root, Category, Product, Version, Section, Document, Heading, Subheading,
Chunk, KBRoot, KBCategory, KBArticle, Tag, Keyword, Image`.

Edge relations: `CONTAINS, IN_CATEGORY, HAS_VERSION, HAS_SECTION, HAS_DOCUMENT,
HAS_HEADING, HAS_SUBHEADING, HAS_CHUNK, NEXT, LINKS_TO, ABOUT_PRODUCT, IN_KB_CATEGORY,
TAGGED, MENTIONS, EMBEDS_IMAGE`.

The **Knowledge Base** is modelled as its own section (`KBRoot`) parallel to the products,
with `KBArticle` nodes tagged `tier: "kb"`, their own `KBCategory` hierarchy, and `Tag` /
`Keyword` nodes from the KB frontmatter. KB articles also link to the product they are about
(`ABOUT_PRODUCT`). Filter any query to KB with `--tier kb` (or regular docs with `--tier docs`).

Product/version/category metadata and citation URLs come straight from the site's own
`../docs/src/config/products.js`, so the chatbot never drifts from the real documentation.

---

## Layout

```
app/
  ndx.mjs            CLI dispatcher
  config.mjs         paths, chunking, provider/model defaults (all env-overridable)
  lib/
    products.mjs     loads the canonical products.js manifest + path/URL helpers
    markdown.mjs     frontmatter + headings + links + heading-aware chunking
    graph.mjs        in-memory property graph (+ JSON persistence, BFS path)
    embeddings.mjs   local | openai | voyage | hash providers
    store.mjs        flat-file vector store (jsonl + packed float32) + cosine search
    ingest.mjs       docs tree -> graph + chunks + manifest
    pipeline.mjs     embed + full build orchestration
    retrieve.mjs     query embedding + vector search (+ tier/product filters)
    chat.mjs         Claude RAG generation (SDK with fetch fallback)
  out/               generated artifacts (gitignored)
```

All tunables are environment variables — see `config.mjs`. Build a subset with
`--product`/`--limit` to iterate fast, then scale to the full base.
