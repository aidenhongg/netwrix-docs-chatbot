// Ingestion: walk the docs tree -> knowledge graph + chunk corpus + manifest.
//
// Produces (in OUT_DIR):
//   graph.json     - nodes + edges (structure; no chunk text)
//   chunks.jsonl   - one embeddable passage per line (with text + citation meta)
//   manifest.json  - high-level description of the transformed docs base

import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { DOCS_ROOT, OUT_DIR, paths, config, slug } from '../config.mjs';
import { buildIndex, getCategories, classifyPath } from './products.mjs';
import { parseMarkdown } from './markdown.mjs';
import { Graph, NODE_TYPES } from './graph.mjs';
import { openChunkWriter } from './store.mjs';
import { log, progress, progressDone, fmtInt } from './log.mjs';

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '0-images', 'images', 'img', 'assets', 'static',
  'screenshots', '.docusaurus', 'build', '__pycache__',
]);
const SKIP_FILES = new Set(['CLAUDE.md']);

function* walk(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      yield* walk(join(dir, ent.name));
    } else if (/\.(md|mdx)$/i.test(ent.name) && !SKIP_FILES.has(ent.name)) {
      yield join(dir, ent.name);
    }
  }
}

const relParts = (abs) => relative(DOCS_ROOT, abs).split(/[\\/]/);
const catId = (name) => `category:${slug(name)}`;
const catName = (c) => (typeof c === 'string' ? c : c.name || c.label || c.id || String(c));

export async function runIngest({ productFilter = null, limit = 0, includeImages = false } = {}) {
  mkdirSync(OUT_DIR, { recursive: true });
  const index = await buildIndex();
  const categories = (await getCategories()).map(catName);

  const g = new Graph();
  g.addNode('root', 'Root', { label: 'Netwrix Product Documentation' });
  for (const c of categories) {
    g.addNode(catId(c), 'Category', { label: c });
    g.addEdge('root', catId(c), 'CONTAINS');
  }

  const chunkWriter = openChunkWriter();
  const linkMap = new Map(); // normalized path/url -> docId
  const pendingLinks = []; // { from, dirParts, targets }
  const counts = { files: 0, documents: 0, kbArticles: 0, chunks: 0, headings: 0, images: 0 };
  const perProduct = new Map(); // pid -> { name, categories, versions:Map, kb:0 }

  const filterSet = productFilter
    ? new Set((Array.isArray(productFilter) ? productFilter : [productFilter]).map((s) => s.toLowerCase()))
    : null;

  // --- node helpers --------------------------------------------------------
  const ensureProduct = (pid) => {
    const id = `product:${pid}`;
    if (g.has(id)) return id;
    const p = index.get(pid);
    const cats = (p && p.categories) || [];
    g.addNode(id, 'Product', {
      label: (p && p.name) || pid,
      productId: pid,
      description: (p && p.description) || '',
      categories: cats,
    });
    g.addEdge('root', id, 'CONTAINS');
    for (const c of cats) {
      g.addNode(catId(c), 'Category', { label: c });
      g.addEdge(id, catId(c), 'IN_CATEGORY');
    }
    if (!perProduct.has(pid))
      perProduct.set(pid, { name: (p && p.name) || pid, categories: cats, versions: new Map(), kb: 0 });
    return id;
  };

  const ensureVersion = (pid, version) => {
    const id = `version:${pid}@${version}`;
    if (g.has(id)) return id;
    const p = index.get(pid);
    const meta = p && p.versions.find((v) => v.version === version);
    g.addNode(id, 'Version', {
      label: `${(p && p.name) || pid} ${version}`,
      productId: pid,
      version,
      isLatest: meta ? meta.isLatest : false,
    });
    g.addEdge(ensureProduct(pid), id, 'HAS_VERSION');
    return id;
  };

  const ensureSectionChain = (parentId, pid, version, parts) => {
    let parent = parentId;
    let acc = [];
    for (const part of parts) {
      acc.push(part);
      const id = `section:${pid}@${version || 'kb'}/${acc.join('/')}`;
      g.addNode(id, 'Section', { label: part, productId: pid });
      g.addEdge(parent, id, 'HAS_SECTION');
      parent = id;
    }
    return parent;
  };

  const ensureKBRoot = () => {
    if (!g.has('kbroot')) {
      g.addNode('kbroot', 'KBRoot', { label: 'Knowledge Base' });
      g.addEdge('root', 'kbroot', 'CONTAINS');
    }
    return 'kbroot';
  };

  const ensureKBCategoryChain = (pid, parts) => {
    let parent = ensureKBRoot();
    let acc = [];
    for (const part of parts) {
      acc.push(part);
      const id = `kbcat:${pid}/${acc.join('/')}`;
      g.addNode(id, 'KBCategory', { label: part, productId: pid });
      g.addEdge(parent, id, 'CONTAINS');
      parent = id;
    }
    return parent;
  };

  // --- main walk -----------------------------------------------------------
  for (const abs of walk(DOCS_ROOT)) {
    const parts = relParts(abs);
    const top = parts[0];
    if (filterSet && !filterSet.has((top === 'kb' ? parts[1] : top || '').toLowerCase())) continue;

    let src;
    try {
      src = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseMarkdown(src, { fallbackTitle: parts[parts.length - 1].replace(/\.(md|mdx)$/i, '') });
    const info = classifyPath(parts, index);
    const pid = info.product;
    ensureProduct(pid);

    const title = parsed.title || info.baseName;
    const relPath = parts.join('/');
    const relNoExt = relPath.replace(/\.(md|mdx)$/i, '');

    let docId, tier, parentId, ref;
    if (info.isKB) {
      tier = 'kb';
      docId = `kb:${info.slugParts.join('/')}`;
      parentId = ensureKBCategoryChain(pid, info.kbCategoryParts);
      g.addNode(docId, 'KBArticle', {
        label: title,
        productId: pid,
        tier,
        url: info.url,
        path: relPath,
        description: parsed.data.description || '',
        knowledgeArticleId: parsed.data.knowledge_article_id || '',
      });
      g.addEdge(parentId, docId, 'CONTAINS');
      g.addEdge(docId, `product:${pid}`, 'ABOUT_PRODUCT');

      // KB-specific: tags + keywords as shared graph nodes
      const tags = [].concat(parsed.data.tags || []);
      for (const t of tags) {
        const tid = `tag:${slug(t)}`;
        g.addNode(tid, 'Tag', { label: t });
        g.addEdge(docId, tid, 'TAGGED');
      }
      const kws = [].concat(parsed.data.keywords || []);
      for (const k of kws) {
        const kid = `kw:${slug(k)}`;
        g.addNode(kid, 'Keyword', { label: k });
        g.addEdge(docId, kid, 'MENTIONS');
      }
      counts.kbArticles++;
      const pp = perProduct.get(pid);
      if (pp) pp.kb++;
      ref = `${info.productName} KB — ${title}`;
    } else {
      tier = 'docs';
      const version = info.version || 'current';
      const versionId = ensureVersion(pid, version);
      docId = `doc:${pid}@${version}/${info.sectionParts.concat(info.baseName).join('/')}`;
      parentId = ensureSectionChain(versionId, pid, version, info.sectionParts);
      g.addNode(docId, 'Document', {
        label: title,
        productId: pid,
        version,
        tier,
        url: info.url,
        path: relPath,
        description: parsed.data.description || '',
        sidebarPosition: parsed.data.sidebar_position ?? null,
      });
      g.addEdge(parentId, docId, 'HAS_DOCUMENT');
      counts.documents++;
      const pp = perProduct.get(pid);
      if (pp) {
        pp.versions.set(version, (pp.versions.get(version) || 0) + 1);
      }
      ref = `${info.productName} ${version} — ${title}`;
    }

    // headings
    const seenSlug = new Map();
    for (const h of parsed.headings) {
      let s = h.slug || slug(h.text);
      const n = (seenSlug.get(s) || 0) + 1;
      seenSlug.set(s, n);
      if (n > 1) s = `${s}-${n}`;
      const hid = `head:${docId}#${s}`;
      const htype = h.level <= 2 ? 'Heading' : 'Subheading';
      g.addNode(hid, htype, { label: h.text, level: h.level });
      g.addEdge(docId, hid, h.level <= 2 ? 'HAS_HEADING' : 'HAS_SUBHEADING');
      counts.headings++;
    }

    // images (optional — there are tens of thousands of assets)
    if (includeImages) {
      for (const srcRef of parsed.images) {
        const iid = `img:${srcRef}`;
        g.addNode(iid, 'Image', { label: srcRef.split('/').pop() });
        g.addEdge(docId, iid, 'EMBEDS_IMAGE');
        counts.images++;
      }
    }

    // chunks -> graph nodes + jsonl records
    let prevChunk = null;
    parsed.chunks.forEach((c, i) => {
      const cid = `chunk:${docId}#${i}`;
      g.addNode(cid, 'Chunk', { index: i, tokens: c.tokens });
      g.addEdge(docId, cid, 'HAS_CHUNK');
      if (prevChunk) g.addEdge(prevChunk, cid, 'NEXT');
      prevChunk = cid;
      chunkWriter.write({
        id: cid,
        docId,
        ref,
        url: info.url,
        tier,
        product: pid,
        version: info.version || null,
        title,
        headingPath: c.headingPath,
        text: c.text,
      });
      counts.chunks++;
    });

    // register for cross-link resolution
    linkMap.set(relNoExt, docId);
    linkMap.set(relPath, docId);
    if (info.url) linkMap.set(info.url.replace(/^\//, ''), docId);
    pendingLinks.push({ from: docId, dirParts: parts.slice(0, -1), targets: parsed.links });

    counts.files++;
    if (counts.files % 500 === 0) progress(`scanned ${fmtInt(counts.files)} files, ${fmtInt(counts.chunks)} chunks…`);
    if (limit && counts.files >= limit) break;
  }
  progressDone(`scanned ${fmtInt(counts.files)} files`);

  // --- resolve cross-links into LINKS_TO edges -----------------------------
  let linkEdges = 0;
  const normalize = (target, dirParts) => {
    let t = target.trim();
    if (t.startsWith('/docs/')) t = t.slice(6);
    else if (t.startsWith('/')) t = t.slice(1);
    else {
      // relative to current dir
      const stack = dirParts.slice();
      for (const seg of t.split('/')) {
        if (seg === '.' || seg === '') continue;
        else if (seg === '..') stack.pop();
        else stack.push(seg);
      }
      t = stack.join('/');
    }
    return t.replace(/\.(md|mdx)$/i, '').replace(/\/$/, '');
  };
  for (const { from, dirParts, targets } of pendingLinks) {
    for (const target of targets) {
      const key = normalize(target, dirParts);
      const to = linkMap.get(key) || linkMap.get(key + '.md') || linkMap.get('docs/' + key);
      if (to && to !== from) {
        if (g.addEdge(from, to, 'LINKS_TO')) linkEdges++;
      }
    }
  }
  log(`resolved ${fmtInt(linkEdges)} cross-document links`);

  chunkWriter.close();
  g.save(paths.graph);
  const gstats = g.stats();

  // --- manifest ------------------------------------------------------------
  const products = [...perProduct.entries()]
    .map(([id, p]) => ({
      id,
      name: p.name,
      categories: p.categories,
      versions: [...p.versions.entries()].map(([version, docCount]) => ({ version, docCount })),
      docCount: [...p.versions.values()].reduce((a, b) => a + b, 0),
      kbArticleCount: p.kb,
    }))
    .sort((a, b) => b.docCount + b.kbArticleCount - (a.docCount + a.kbArticleCount));

  const manifest = {
    name: 'Netwrix Documentation Knowledge Graph',
    generatedAt: new Date().toISOString(),
    source: relative(OUT_DIR, DOCS_ROOT).replace(/\\/g, '/'),
    params: {
      chunk: config.chunk,
      includeImages,
      productFilter: productFilter || 'all',
      limit: limit || null,
    },
    counts: { ...counts, nodes: gstats.nodes, edges: gstats.edges, links: linkEdges },
    graph: { nodeTypes: gstats.byType, edgeRelations: gstats.byRel, schema: { nodeTypes: NODE_TYPES } },
    categories,
    products,
    embedding: null, // filled in by the embed step
  };
  writeFileSync(paths.manifest, JSON.stringify(manifest, null, 2));

  return { counts, gstats, manifest };
}

export default { runIngest };
