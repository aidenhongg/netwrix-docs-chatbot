# ndx — Netwrix Docs Knowledge Graph + RAG Chatbot

A small, dependency-light pipeline that turns the entire Netwrix documentation base
(`../docs/docs`, ~18k markdown files across ~28 products + a Knowledge Base) into:

- a **knowledge graph** (`out/graph.json`) with rich node types,
- **three embedding spaces** keyed by node id — `chunk` (passages), `doc` (whole
  articles), `heading` (sections) — in `out/emb/<level>.{jsonl,f32}`,
- a **manifest** (`out/manifest.json`) describing the transformed base,

and a CLI (`ndx.mjs`) to **search** (at any level), find **similar** nodes, **cluster**
nodes into communities, and **traverse the graph**.

It deliberately stops at **retrieval primitives** — there is no built-in answer/LLM layer,
so you can compose your own (query form, sub-agent, hybrid, or none) on `retrieve()` /
`similar()` without inheriting an encoded strategy.

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

# 3) Semantic search at any level (works with any provider, no API key)
node ndx.mjs search "configure data collection" --product 1secure          # passages
node ndx.mjs search "configure data collection" --level doc --product 1secure   # whole docs

# 4) Node primitives: nearest nodes + community detection
node ndx.mjs similar doc:1secure@current/admin/overview --cross-tier
node ndx.mjs cluster --level doc --product 1secure --threshold 0.6

# 5) Traverse the graph
node ndx.mjs node product:1secure                # also lists its nearest doc nodes
node ndx.mjs neighbors kbroot --rel CONTAINS
```

Drop `--product 1secure` to build the **whole** base.

---

## Commands

```
BUILD
  build      Ingest docs + embed all levels (full pipeline)
  ingest     Build graph + item corpora + manifest (no embeddings)
  embed      Embed the item corpora into the vector stores   [--levels chunk,doc,heading]

INSPECT
  stats      Node/edge/type + per-level embedding counts
  manifest   Manifest summary (products, versions, KB counts)
  node <id>  Show a node + neighbours + its nearest nodes
  neighbors <id>   List neighbours          [--rel R --dir out|in|both]
  path <a> <b>     Shortest path between two nodes

QUERY  (--level chunk|doc|heading picks the embedding space; default chunk)
  search <query>   Semantic search          [--level L -k N --tier docs|kb --product id]
  similar <nodeId> Nearest nodes to a node  [-k N --cross-tier --product id --level L]
  cluster          Community detection       [--level doc|heading --tier docs|kb --product id --threshold T]

TUNE THE RANKER  (KB articles as labels — see "Tuning the ranking function" below)
  labels           Build + show the labeled query→gold set
  eval <flags>     Score one ranking config (CIs, per-product, per-field)
  tune <flags>     Sweep configs; leaderboard by held-out metric (CV / holdout / LOPO)
```

Common flags: `--product <id>`, `--limit <n>`, `--images`, `--level <chunk|doc|heading>`,
`--provider local|openai|voyage|hash`, `--embed-model <name>`, `--levels <list>`.

## Semantic levels & node primitives

Every node that holds text is embedded into one of three spaces, **keyed by its node id**
(so `graph.json` stays lean and any node is semantically searchable):

| Level | What's embedded | Good for |
|-------|-----------------|----------|
| `chunk` | passage + heading breadcrumb | RAG answers, precise retrieval |
| `doc` | whole Document/KBArticle (title, description, **KB: keywords+tags**, outline, lead) | find-similar-docs, cross-version equivalents, clustering |
| `heading` | each section (breadcrumb + body) | jump-to-section ("…the Resolution steps") |

Primitives built on these:

- **`search --level <L>`** — semantic search at the chosen granularity.
- **`similar <nodeId>`** — nearest nodes to an existing node in its own space (e.g. a doc's
  cross-version twins, or its topical neighbours). Infers the level from the id.
- **`cluster`** — connected-components community detection over node vectors (union-find on
  cosine ≥ `--threshold`). Bounded to a product/tier so it stays fast.

**KB vs regular docs is handled deliberately at every level.** KB articles carry
`tier: "kb"` and fold their `keywords`/`tags`/symptom-resolution body into the doc-level text;
regular docs use description + heading outline. `search`/`cluster` take `--tier docs|kb`, and
`similar` stays **within a node's tier by default** (KB↔KB, docs↔docs) — pass `--cross-tier`
to bridge (e.g. surface the KB articles closest to a doc, or vice-versa).

## Tuning the ranking function (KB articles as labels)

The KB is a free, in-domain **labeled relevance set**: each article's `title` / `keywords` /
`description` / `symptom` text is a query whose relevant answer is known. `ndx` turns that into
an offline harness for tuning *retrieval ranking* (no LLM, no generation) — measure one config,
or sweep configs with proper cross-validation.

```bash
node ndx.mjs labels --target kb                            # build labels; show coverage
node ndx.mjs eval --level doc --signal rrf                 # score ONE config (CIs, per product, per field)
node ndx.mjs tune --levels doc,chunk --metric mrr --cv 5   # sweep configs; held-out leaderboard
node ndx.mjs tune --query-fields symptom --lopo            # generalize across products
```

**The ranking config you tune:** `--level chunk|doc|heading` · `--signal vector|bm25|linear|rrf`
· `--alpha` (linear) · `--pool max|mean|sum` (how chunk/heading hits pool up to a doc) ·
`--candN`. BM25 is a built-in zero-dep lexical index, so hybrid fusion (`linear`, `rrf`) has a
real α and rank-fusion to tune — not just `level`.

**Labels (`--target` / `--gold`):**
- `kb` (default) — gold = the KB article itself; queries from its own fields. The large set (~1,400 articles).
- `kb --gold link` — gold = the doc(s) the article `LINKS_TO` (sparse in this export: ~9 articles).
- `doc` — gold = a regular doc; queries from its title/headings (the docs-base slice).
- `--query-fields title,description,keywords,symptom` — choose which. **Always reported per field**,
  because `title`/`keywords`/`description` self-match at doc level (they're *in* the embedded text),
  while `symptom` is the realistic, discriminative query.

**Splits (all grouped by article + stratified by product, seeded — `--seed`):**
- `--cv 5` — grouped, stratified **k-fold CV** (default).
- `--holdout 0.3` — grouped train/test split.
- `--lopo` — **leave-one-product-out**: does the config generalize to a product it never saw?
- `--final-holdout 0.2` — carve an untouched test set; the CV winner is re-scored on it.

**Metrics:** MRR, Hit@1/5/10, Recall@10, nDCG@10 — reported overall (bootstrap CIs over groups),
macro-averaged across products, and broken out per product and per query-field. Choose the tuning
objective with `--metric mrr|ndcg@10|recall@10|hit@5`.

**Why grouped + stratified, not random:** one article yields several *correlated* queries — split
by article so they don't straddle folds; and KB volume is wildly imbalanced across products (auditor
has 641, many have 0) — stratify + macro-average so one product can't dominate. The per-field numbers
expose self-retrieval leakage instead of hiding it. (`build` indexes the KB articles, so they're
retrievable in production; these labels measure how well that retrieval ranks them.)

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

## Building an answer layer (bring your own)

This is a **retrieval harness, not a chatbot** — there is intentionally no built-in
generation/LLM step, so no answer strategy is baked in. Compose whatever you want on top of
the primitives:

```js
import { retrieve, similar } from './lib/retrieve.mjs';

const hits = await retrieve('how do I reset a password', { level: 'chunk', k: 8, tier: 'kb' });
// hits: [{ id, score, ref, url, tier, product, version, text, ... }]
// → format these however you like and call any model, run a sub-agent, a query form, or nothing.
```

Nothing in the harness calls an LLM, so it has **no required dependencies** (only the
optional on-device embedder, used for `--provider local`).

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
    markdown.mjs     frontmatter + headings + links + sections + heading-aware chunking
    embedtext.mjs    builds doc-level & heading-level embedding text (KB-aware)
    graph.mjs        in-memory property graph (+ JSON persistence, BFS path)
    embeddings.mjs   local | openai | voyage | hash providers
    store.mjs        per-level vector stores (jsonl + packed float32) + cosine search
    ingest.mjs       docs tree -> graph + chunk/doc/heading corpora + manifest
    pipeline.mjs     per-level embed + full build orchestration
    retrieve.mjs     retrieve(level) + similar(nodeId) — tier-aware (the composition seam)
    cluster.mjs      community detection over node vectors (union-find)
    bm25.mjs         zero-dep BM25 lexical index
    rank.mjs         tunable ranking function (vector + BM25, fusion, pooling)
    labels.mjs       KB-derived (query→gold) relevance labels
    splits.mjs       grouped/stratified holdout · k-fold · leave-one-product-out
    metrics.mjs      MRR / Hit / Recall / nDCG + bootstrap CIs
    evaluate.mjs     eval one config · tune (CV/holdout/LOPO) leaderboard
    rng.mjs          seeded PRNG for reproducible splits
  out/               generated artifacts, incl. emb/<level>.{jsonl,f32} (gitignored)
```

All tunables are environment variables — see `config.mjs`. Build a subset with
`--product`/`--limit` to iterate fast, then scale to the full base.
