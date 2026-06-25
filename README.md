# Netwrix Docs — Knowledge Graph + Retrieval Harness (`ndx`)

A knowledge graph + multi-level vector search over the Netwrix product documentation
(~18k markdown files across ~29 products + a Knowledge Base). A harness for building a
docs chatbot — it provides the retrieval primitives and leaves the answer layer to you.

It lives in **[`app/`](app/)** and is driven by a single CLI (`node ndx.mjs`). It transforms
the docs base into a property graph + multi-level vector stores + a manifest, then exposes
retrieval primitives — semantic search (chunk/doc/heading level), nearest-node `similar`,
community `cluster`, and graph traversal. No built-in LLM/answer layer: you compose your own.

➡️ **Full usage: [`app/README.md`](app/README.md)**

## Quick start

```bash
cd app
node ndx.mjs build --provider hash          # build the whole base, offline + free
node ndx.mjs search "reset a forgotten password"
node ndx.mjs search "configure auditing" --level doc --product auditor
node ndx.mjs similar doc:auditor@10.8/configuration/activedirectory/registrykey
node ndx.mjs manifest                        # overview of the transformed base
```

It's a **retrieval harness, not a chatbot** — no built-in answer/LLM step, so no answer
strategy is baked in. Build your own on `retrieve()` / `similar()` (see
[`app/README.md`](app/README.md)).

The Netwrix documentation itself is a **separate repository** and is not vendored
here; the tool reads it from a sibling `./docs/docs` checkout at build time.
