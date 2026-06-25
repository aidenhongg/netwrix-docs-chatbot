#!/usr/bin/env node
// ndx — Netwrix documentation knowledge-graph + retrieval harness CLI.
//
//   node ndx.mjs <command> [args] [--flags]
//
// Build:    build · ingest · embed
// Inspect:  stats · manifest · node · neighbors · path
// Query:    search · similar · cluster
// Tune:     labels · eval · tune   (KB articles as ranking labels)
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
const splitList = (s) => String(s).split(',').map((x) => x.trim()).filter(Boolean);

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

TUNE THE RANKER  (KB articles as labels — gold = the KB article itself by default)
  labels              Build + cache the labeled query→gold set; show coverage
  eval <flags>        Score ONE ranking config: MRR/Hit@k/Recall@10/nDCG@10 (+CIs),
                        broken out per product and per query-field
  tune <flags>        Sweep ranking configs; leaderboard by held-out metric
    labels:  --target kb|doc  --gold self|link  --query-fields title,description,keywords,symptom  --product id  --labels <file>
    ranker:  --level chunk|doc|heading  --signal vector|bm25|linear|rrf  --alpha 0.5  --pool max|mean|sum  --candN 200
    grid:    --levels doc,chunk  --signals vector,bm25,rrf  --pools max,mean  --alphas 0.3,0.5,0.7
    splits:  --cv 5 | --holdout 0.3 | --lopo    --final-holdout 0.2   --metric mrr|ndcg@10|recall@10|hit@5   --seed 1

ENV
  NDX_EMBED_PROVIDER  local (default) | openai | voyage | hash
  OPENAI_API_KEY / VOYAGE_API_KEY    keys for those embedding providers (local/hash need none)

EXAMPLES
  node ndx.mjs build --product auditor --provider hash
  node ndx.mjs search "active directory permissions outdated" --tier kb
  node ndx.mjs similar doc:auditor@10.8/configurator/install --cross-tier
  node ndx.mjs cluster --level doc --tier kb --product accessanalyzer
  node ndx.mjs labels --target kb
  node ndx.mjs eval --level doc --signal rrf
  node ndx.mjs tune --levels doc,chunk --metric ndcg@10 --cv 5`;

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

// --- ranking-function tuning harness (KB articles as labels) ---------------

async function getLabels(flags) {
  const { buildLabels, loadLabelsFile } = await import('./lib/labels.mjs');
  if (flags.labels && flags.labels !== true) return loadLabelsFile(flags.labels);
  return buildLabels({
    target: flags.target || 'kb',
    gold: flags.gold || 'self',
    queryFields: flags['query-fields'] ? splitList(flags['query-fields']) : undefined,
    product: flags.product || null,
  });
}

async function cmdLabels(flags) {
  const { buildLabels, saveLabels, labelStats } = await import('./lib/labels.mjs');
  const target = flags.target || 'kb';
  const gold = flags.gold || 'self';
  const recs = buildLabels({
    target,
    gold,
    queryFields: flags['query-fields'] ? splitList(flags['query-fields']) : undefined,
    product: flags.product || null,
  });
  const path = saveLabels(recs, target);
  const st = labelStats(recs);
  out(`\n${fmtInt(st.records)} labels · ${fmtInt(st.groups)} groups · target=${target} gold=${gold}`);
  out(`saved -> ${path}`);
  out(`\nby query field:`);
  for (const [k, v] of Object.entries(st.byField).sort((a, b) => b[1] - a[1])) out(`  ${k.padEnd(12)} ${fmtInt(v)}`);
  out(`\nby product (top 15 of ${Object.keys(st.byProduct).length}):`);
  Object.entries(st.byProduct).sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([k, v]) => out(`  ${k.padEnd(26)} ${fmtInt(v)}`));
}

async function cmdEval(flags) {
  const { evaluateConfig } = await import('./lib/evaluate.mjs');
  let recs = await getLabels(flags);
  if (flags.holdout) {
    const { holdoutGroups } = await import('./lib/splits.mjs');
    const { test } = holdoutGroups(recs, { testFrac: Number(flags.holdout), seed: Number(flags.seed || 1) });
    recs = test.map((i) => recs[i]);
    log(`evaluating on grouped holdout test slice (${Math.round(Number(flags.holdout) * 100)}%)`);
  }
  const config = {
    level: flags.level || 'doc',
    signal: flags.signal || 'rrf',
    alpha: Number(flags.alpha ?? 0.5),
    pool: flags.pool || 'max',
    rrfK: Number(flags.rrfK || 60),
    candN: Number(flags.candN || 200),
  };
  log(`evaluating ${fmtInt(recs.length)} queries · level=${config.level} signal=${config.signal} pool=${config.pool}`);
  const rep = await evaluateConfig(recs, config, { candN: config.candN });
  const ci = (m) => `${m.mean.toFixed(3)} [${m.lo.toFixed(3)}, ${m.hi.toFixed(3)}]`;
  out(`\nConfig: level=${config.level} signal=${config.signal}${config.signal === 'linear' ? '@' + config.alpha : ''} pool=${config.pool}   (n=${fmtInt(rep.n)})`);
  out(`\nOverall (95% CI, bootstrap over groups):`);
  for (const k of ['mrr', 'hit@1', 'hit@5', 'hit@10', 'recall@10', 'ndcg@10']) out(`  ${k.padEnd(10)} ${ci(rep.overall[k])}`);
  out(`\nMacro-avg over products:  mrr=${rep.macro.mrr.toFixed(3)}  ndcg@10=${rep.macro['ndcg@10'].toFixed(3)}  hit@5=${rep.macro['hit@5'].toFixed(3)}`);
  out(`\nBy query field   (mrr · hit@5 · ndcg@10 · n):`);
  for (const f of rep.byField) out(`  ${String(f.field).padEnd(12)} ${f.mrr.toFixed(3)}  ${f['hit@5'].toFixed(3)}  ${f['ndcg@10'].toFixed(3)}  ${fmtInt(f.n)}`);
  out(`\nPer product   (mrr · hit@5 · n):`);
  const pp = rep.perProduct;
  const show = pp.length > 12 ? [...pp.slice(0, 6), null, ...pp.slice(-6)] : pp;
  for (const p of show) out(p === null ? '  …' : `  ${String(p.product).padEnd(26)} ${p.mrr.toFixed(3)}  ${p['hit@5'].toFixed(3)}  ${fmtInt(p.n)}`);
}

function flagsToEval(c) {
  let s = `--level ${c.level} --signal ${c.signal} --pool ${c.pool}`;
  if (c.signal === 'linear') s += ` --alpha ${c.alpha}`;
  return s;
}

async function cmdTune(flags) {
  const { tune } = await import('./lib/evaluate.mjs');
  const recs = await getLabels(flags);
  const grid = {
    levels: splitList(flags.levels || 'doc,chunk'),
    signals: splitList(flags.signals || 'vector,bm25,rrf'),
    pools: splitList(flags.pools || 'max,mean'),
    alphas: flags.alphas ? splitList(flags.alphas).map(Number) : [0.3, 0.5, 0.7],
    candN: Number(flags.candN || 200),
  };
  const opts = {
    metric: flags.metric || 'mrr',
    seed: Number(flags.seed || 1),
    candN: grid.candN,
    finalHoldout: Number(flags['final-holdout'] || 0),
  };
  if (flags.lopo) opts.lopo = true;
  else if (flags.holdout) opts.holdout = Number(flags.holdout);
  else opts.cv = Number(flags.cv || 5);

  log(`tuning ${fmtInt(recs.length)} queries…`);
  const res = await tune(recs, grid, opts);
  out(`\nTuned ${res.configs} configs · ${res.scheme} · metric=${res.metric} · n=${fmtInt(res.n)}`);
  out(`folds: ${res.folds.map((f) => `${f.name}(${fmtInt(f.n)})`).join('  ')}`);
  out(`\n  #  ${res.metric.padEnd(10)} ±std    config`);
  res.leaderboard.forEach((row, i) => out(`  ${String(i + 1).padStart(2)}  ${row.metric.toFixed(3)}  ±${row.std.toFixed(3)}   ${row.key}`));
  const best = res.leaderboard[0];
  out(`\nBest: ${best.key}   (${res.metric}=${best.metric.toFixed(3)} ±${best.std.toFixed(3)})`);
  if (res.finalReport) {
    const o = res.finalReport.report.overall;
    out(`Winner on untouched final holdout (${res.finalReport.key}): mrr=${o.mrr.mean.toFixed(3)} [${o.mrr.lo.toFixed(3)}, ${o.mrr.hi.toFixed(3)}]  ndcg@10=${o['ndcg@10'].mean.toFixed(3)}`);
  }
  out(`\nInspect the winner in full: node ndx.mjs eval ${flagsToEval(best.config)}`);
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
      case 'labels': return await cmdLabels(flags);
      case 'eval': return await cmdEval(flags);
      case 'tune': return await cmdTune(flags);
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
