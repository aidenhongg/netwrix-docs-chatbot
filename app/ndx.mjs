#!/usr/bin/env node
// ndx — Netwrix documentation knowledge-graph + retrieval harness CLI.
//
//   node ndx.mjs <command> [args] [--flags]
//
// Build:    build · ingest · embed
// Inspect:  stats · manifest · node · neighbors · path
// Query:    search · similar · cluster
//
// Retrieval primitives only — no built-in answer/LLM layer (compose your own on
// retrieve()/similar()). Run `node ndx.mjs help` for the full list.

import { existsSync, readFileSync } from 'node:fs';
import { paths } from './config.mjs';
import { out, log, fmtInt } from './lib/log.mjs';

// --- tiny arg parser -------------------------------------------------------
function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else if (a.startsWith('-') && a.length > 1 && isNaN(Number(a))) {
      const key = a.slice(1);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else {
      pos.push(a);
    }
  }
  return { flags, pos };
}

const embedOver = (f) => {
  const o = {};
  if (f.provider) o.provider = f.provider;
  if (f['embed-model']) o.model = f['embed-model']; // --model is reserved for the chat model
  return o;
};
const levelsOf = (f) => (f.levels ? String(f.levels).split(',').map((s) => s.trim()).filter(Boolean) : null);
const fmtByLevel = (bl) => Object.entries(bl).map(([l, v]) => `${l}=${fmtInt(v.count)} (${v.dim}d)`).join(', ');

const HELP = `ndx — Netwrix documentation knowledge graph + retrieval harness

USAGE
  node ndx.mjs <command> [args] [--flags]

BUILD
  build               Ingest docs + embed all levels (full pipeline)
  ingest              Build graph + item corpora + manifest (no embeddings)
  embed               Embed the item corpora into the vector stores
    flags: --product <id>  --limit <n>  --images
           --provider local|openai|voyage|hash  --embed-model <name>
           --levels chunk,doc,heading   (default: all)

INSPECT
  stats               Node/edge/type/embedding counts for the built graph
  manifest            Print the manifest summary
  node <id>           Show a node, its neighbours, and its nearest nodes
  neighbors <id>      List neighbours          [--rel R --dir out|in|both]
  path <a> <b>        Shortest path between two node ids

QUERY  (--level chunk|doc|heading selects the embedding space; default chunk)
  search <query>      Semantic search          [--level L -k N --tier docs|kb --product id]
  similar <nodeId>    Nearest nodes to a node  [-k N --cross-tier --product id --level L]
  cluster             Community detection       [--level doc|heading --tier docs|kb --product id --threshold 0.55]

  (No answer/LLM command by design — compose your own on retrieve()/similar(); see README.)

ENV
  NDX_EMBED_PROVIDER  local (default) | openai | voyage | hash
  OPENAI_API_KEY / VOYAGE_API_KEY    keys for those embedding providers (local/hash need none)

EXAMPLES
  node ndx.mjs build --product auditor --provider hash
  node ndx.mjs search "active directory permissions outdated" --tier kb
  node ndx.mjs search "configure auditing" --level doc --product auditor
  node ndx.mjs similar doc:auditor@10.8/configurator/install --cross-tier
  node ndx.mjs cluster --level doc --tier kb --product accessanalyzer`;

// --- commands --------------------------------------------------------------

async function cmdBuild(flags) {
  const { runBuild } = await import('./lib/pipeline.mjs');
  const r = await runBuild({
    productFilter: flags.product || null,
    limit: Number(flags.limit || 0),
    includeImages: !!flags.images,
    embed: { ...embedOver(flags), levels: levelsOf(flags) },
  });
  out(
    `\nBuilt graph: ${fmtInt(r.ing.counts.documents)} docs, ${fmtInt(r.ing.counts.kbArticles)} KB articles, ` +
      `${fmtInt(r.ing.gstats.nodes)} nodes, ${fmtInt(r.ing.gstats.edges)} edges.`
  );
  out(`Embedded (${r.emb.provider}:${r.emb.model}): ${fmtByLevel(r.emb.byLevel)}`);
  out(`Artifacts in ${paths.manifest.replace(/manifest\.json$/, '')}`);
}

async function cmdIngest(flags) {
  const { runIngest } = await import('./lib/ingest.mjs');
  const r = await runIngest({
    productFilter: flags.product || null,
    limit: Number(flags.limit || 0),
    includeImages: !!flags.images,
  });
  out(
    `\nIngested ${fmtInt(r.counts.files)} files -> ${fmtInt(r.gstats.nodes)} nodes, ` +
      `${fmtInt(r.gstats.edges)} edges, ${fmtInt(r.counts.chunks)} chunks.`
  );
  out('Run `node ndx.mjs embed` next (or use `build` to do both).');
}

async function cmdEmbed(flags) {
  const { runEmbed } = await import('./lib/pipeline.mjs');
  const r = await runEmbed({ ...embedOver(flags), levels: levelsOf(flags) });
  out(`Embedded (${r.provider}:${r.model}): ${fmtByLevel(r.byLevel)}`);
}

function loadManifest() {
  if (!existsSync(paths.manifest)) throw new Error('No manifest. Run `node ndx.mjs ingest` or `build` first.');
  return JSON.parse(readFileSync(paths.manifest, 'utf8'));
}

function cmdStats() {
  const m = loadManifest();
  out(`\n${m.name}`);
  out(`generated ${m.generatedAt}`);
  out(`\nCounts:`);
  for (const [k, v] of Object.entries(m.counts)) out(`  ${k.padEnd(12)} ${fmtInt(v)}`);
  out(`\nNode types:`);
  for (const [k, v] of Object.entries(m.graph.nodeTypes).sort((a, b) => b[1] - a[1]))
    out(`  ${k.padEnd(12)} ${fmtInt(v)}`);
  out(`\nEdge relations:`);
  for (const [k, v] of Object.entries(m.graph.edgeRelations).sort((a, b) => b[1] - a[1]))
    out(`  ${k.padEnd(14)} ${fmtInt(v)}`);
  if (m.embedding && m.embedding.byLevel) {
    out(`\nEmbedding (${m.embedding.provider}:${m.embedding.model}):`);
    for (const [lvl, info] of Object.entries(m.embedding.byLevel))
      out(`  ${lvl.padEnd(8)} ${String(fmtInt(info.count)).padStart(8)} vectors  ${info.dim}d`);
  } else out(`\nEmbedding: (not built yet — run \`node ndx.mjs embed\`)`);
}

function cmdManifest() {
  const m = loadManifest();
  out(`\n${m.name}  —  generated ${m.generatedAt}`);
  out(`${fmtInt(m.counts.documents)} docs · ${fmtInt(m.counts.kbArticles)} KB articles · ${fmtInt(m.counts.chunks)} chunks`);
  if (m.embedding && m.embedding.byLevel)
    out(`embeddings (${m.embedding.provider}:${m.embedding.model}): ${Object.entries(m.embedding.byLevel).map(([l, v]) => `${l} ${fmtInt(v.count)}×${v.dim}d`).join('  ·  ')}`);
  out(`\nProducts (${m.products.length}):`);
  for (const p of m.products) {
    const vers = p.versions.map((v) => `${v.version}:${v.docCount}`).join(' ');
    out(`  ${p.id.padEnd(26)} ${String(p.docCount).padStart(5)} docs  ${String(p.kbArticleCount).padStart(4)} KB   ${vers}`);
  }
  out(`\nCategories: ${m.categories.join(', ')}`);
}

async function withGraph(fn) {
  const { Graph } = await import('./lib/graph.mjs');
  if (!existsSync(paths.graph)) throw new Error('No graph. Run `node ndx.mjs ingest` or `build` first.');
  return fn(Graph.load(paths.graph));
}

function cmdNode(id) {
  return withGraph(async (g) => {
    const n = g.get(id);
    if (!n) return out(`Node not found: ${id}\n(tip: use \`search\` to find docs, ids look like doc:auditor@10.6/...)`);
    out(`\n${n.type}  ${n.id}`);
    for (const [k, v] of Object.entries(n))
      if (k !== 'id' && k !== 'type') out(`  ${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
    const outN = g.neighbors(id, { dir: 'out' });
    const inN = g.neighbors(id, { dir: 'in' });
    out(`\n  out (${outN.length}):`);
    for (const e of outN.slice(0, 25)) out(`    -${e.rel}-> ${e.id}`);
    if (outN.length > 25) out(`    … +${outN.length - 25} more`);
    out(`  in (${inN.length}):`);
    for (const e of inN.slice(0, 25)) out(`    <-${e.rel}- ${e.id}`);
    if (inN.length > 25) out(`    … +${inN.length - 25} more`);

    // semantically nearest nodes (best-effort: needs that level embedded)
    try {
      const { similar, levelForNode } = await import('./lib/retrieve.mjs');
      const lvl = levelForNode(id);
      if (lvl) {
        const sims = similar(id, { k: 5 });
        if (sims.length) {
          out(`\n  ~ nearest ${lvl} nodes:`);
          for (const s of sims) out(`    ${s.score.toFixed(3)}  ${s.id}  ${s.label || ''}`);
        }
      }
    } catch {
      /* vectors not built, or node not embedded at its level */
    }
  });
}

function cmdNeighbors(id, flags) {
  return withGraph((g) => {
    if (!g.has(id)) return out(`Node not found: ${id}`);
    const ns = g.neighbors(id, { dir: flags.dir || 'out', rel: flags.rel || null });
    out(`\n${ns.length} neighbour(s) of ${id} [dir=${flags.dir || 'out'}${flags.rel ? ' rel=' + flags.rel : ''}]:`);
    for (const e of ns) {
      const n = g.get(e.id);
      const arrow = e.dir === 'in' ? `<-${e.rel}-` : `-${e.rel}->`;
      out(`  ${arrow} ${e.id}  ${n ? `(${n.type}: ${n.label || ''})` : ''}`);
    }
  });
}

function cmdPath(a, b) {
  return withGraph((g) => {
    const p = g.path(a, b);
    if (!p) return out(`No path between\n  ${a}\n  ${b}`);
    out('');
    p.forEach((id, i) => {
      const n = g.get(id);
      out(`${'  '.repeat(i)}${i ? '└─ ' : ''}${id}  ${n ? `(${n.type})` : ''}`);
    });
  });
}

async function cmdSearch(query, flags) {
  const { retrieve } = await import('./lib/retrieve.mjs');
  const level = flags.level || 'chunk';
  const hits = await retrieve(query, {
    level,
    k: Number(flags.k || 8),
    tier: flags.tier || null,
    product: flags.product || null,
  });
  out(`\nTop ${hits.length} ${level} for: "${query}"\n`);
  hits.forEach((h, i) => {
    out(`[${i + 1}] ${h.score.toFixed(3)}  ${h.ref}`);
    if (h.url) out(`     ${h.url}`);
    if (level !== 'doc') {
      const snippet = (h.text || '').replace(/\s+/g, ' ').slice(0, 200);
      out(`     ${snippet}…`);
    }
    out(`     id: ${h.id}`);
    out('');
  });
}

async function cmdSimilar(id, flags) {
  const { similar } = await import('./lib/retrieve.mjs');
  const crossTier = !!(flags['cross-tier'] || flags.crossTier);
  const hits = similar(id, {
    k: Number(flags.k || 8),
    crossTier,
    product: flags.product || null,
    level: flags.level || null,
  });
  out(`\n${hits.length} nodes similar to ${id}${crossTier ? ' (cross-tier)' : ''}:\n`);
  hits.forEach((h, i) => {
    out(`[${i + 1}] ${h.score.toFixed(3)}  ${h.type || ''} ${h.tier ? '(' + h.tier + ')' : ''}  ${h.label || h.ref}`);
    if (h.url) out(`     ${h.url}`);
    out(`     id: ${h.id}`);
  });
}

async function cmdCluster(flags) {
  const { cluster } = await import('./lib/cluster.mjs');
  const level = flags.level || 'doc';
  const threshold = Number(flags.threshold || 0.55);
  const r = cluster({
    level,
    tier: flags.tier || null,
    product: flags.product || null,
    threshold,
    top: Number(flags.top || 25),
  });
  out(`\n${r.clusters.length} clusters over ${fmtInt(r.n)} ${level} nodes (cosine ≥ ${threshold}); ${fmtInt(r.singletons)} singletons.\n`);
  r.clusters.forEach((c, i) => {
    out(`#${i + 1}  (${c.size})  ${c.label}`);
    for (const m of c.members) out(`     - ${m.label}  [${m.tier}${m.version ? ' ' + m.version : ''}]  ${m.id}`);
    out('');
  });
}

// --- dispatch --------------------------------------------------------------
async function main() {
  const [, , cmd, ...rest] = process.argv;
  const { flags, pos } = parseArgs(rest);
  try {
    switch (cmd) {
      case 'build': return await cmdBuild(flags);
      case 'ingest': return await cmdIngest(flags);
      case 'embed': return await cmdEmbed(flags);
      case 'stats': return cmdStats();
      case 'manifest': return cmdManifest();
      case 'node': return await cmdNode(pos[0]);
      case 'neighbors': case 'neighbours': return await cmdNeighbors(pos[0], flags);
      case 'path': return await cmdPath(pos[0], pos[1]);
      case 'search': return await cmdSearch(pos.join(' '), flags);
      case 'similar': return await cmdSimilar(pos[0], flags);
      case 'cluster': return await cmdCluster(flags);
      case 'help': case undefined: case '--help': case '-h': return out(HELP);
      default:
        out(`Unknown command: ${cmd}\n`);
        out(HELP);
        process.exitCode = 1;
    }
  } catch (e) {
    log(`error: ${e.message}`);
    process.exitCode = 1;
  }
}

main();
