# Netwrix Docs Chatbot (`ndx`)

A knowledge-graph + RAG chatbot over the Netwrix product documentation
(~18k markdown files across ~29 products + a Knowledge Base).

The chatbot lives in **[`app/`](app/)** and is driven by a single CLI (`node ndx.mjs`).
It transforms the docs base into a property graph, an embeddable chunk corpus, a
vector store, and a manifest, then lets you traverse the graph, run semantic
search, and ask questions answered by Claude with citations.

➡️ **Full usage: [`app/README.md`](app/README.md)**

## Quick start

```bash
cd app
node ndx.mjs build --provider hash          # build the whole base, offline + free (~13s)
node ndx.mjs search "reset a forgotten password"
node ndx.mjs manifest                        # overview of the transformed base

export ANTHROPIC_API_KEY=sk-ant-...          # for generated answers (defaults to claude-haiku-4-5)
node ndx.mjs ask "How do I configure SQL Server auditing?" --product auditor
```

The Netwrix documentation itself is a **separate repository** and is not vendored
here; the tool reads it from a sibling `./docs/docs` checkout at build time.
