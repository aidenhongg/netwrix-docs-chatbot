// A small, fast, in-memory property graph with JSON persistence.
//
// Node types used by the ingester (declared here for documentation/validation;
// "too many are OK" — the retriever only needs a subset):
//
//   Root        - the documentation base (single god node)
//   Category    - product category / cross-cutting tag (DSPM, ITDR, ...)
//   Product     - a Netwrix product
//   Version     - a product version (11.6, 12.0, 2601, current, ...)
//   Section     - a folder grouping within a version (nestable: Hierarchical)
//   Document    - a regular docs article (.md/.mdx)
//   Heading     - an H1/H2 inside a document
//   Subheading  - an H3..H6 inside a document
//   Chunk       - an embeddable passage of a document/article
//   KBRoot      - the Knowledge Base god node (its own section)
//   KBCategory  - a KB topic category (troubleshooting, reports, ...)
//   KBArticle   - a KB troubleshooting/how-to article (Document subtype)
//   Tag         - a KB tag
//   Keyword     - a KB keyword
//   Image       - a referenced image asset
//
// Edge relations:
//   CONTAINS, IN_CATEGORY, HAS_VERSION, HAS_SECTION, HAS_DOCUMENT, HAS_HEADING,
//   HAS_SUBHEADING, HAS_CHUNK, NEXT, LINKS_TO, ABOUT_PRODUCT, IN_KB_CATEGORY,
//   TAGGED, MENTIONS, EMBEDS_IMAGE

import { readFileSync, writeFileSync } from 'node:fs';

export const NODE_TYPES = [
  'Root', 'Category', 'Product', 'Version', 'Section', 'Document', 'Heading',
  'Subheading', 'Chunk', 'KBRoot', 'KBCategory', 'KBArticle', 'Tag', 'Keyword', 'Image',
];

export class Graph {
  constructor() {
    this.nodes = new Map(); // id -> { id, type, label, ...attrs }
    this.out = new Map(); // id -> [{ to, rel }]
    this.in = new Map(); // id -> [{ from, rel }]
    this.edgeCount = 0;
  }

  addNode(id, type, attrs = {}) {
    let n = this.nodes.get(id);
    if (!n) {
      n = { id, type, ...attrs };
      this.nodes.set(id, n);
      this.out.set(id, []);
      this.in.set(id, []);
    } else {
      // merge new attrs (last write wins, but don't clobber with undefined)
      for (const [k, v] of Object.entries(attrs)) if (v !== undefined) n[k] = v;
    }
    return n;
  }

  has(id) {
    return this.nodes.has(id);
  }
  get(id) {
    return this.nodes.get(id);
  }

  addEdge(from, to, rel) {
    if (!this.nodes.has(from) || !this.nodes.has(to)) return false;
    // de-dupe identical edges
    const o = this.out.get(from);
    if (o.some((e) => e.to === to && e.rel === rel)) return false;
    o.push({ to, rel });
    this.in.get(to).push({ from, rel });
    this.edgeCount++;
    return true;
  }

  neighbors(id, { dir = 'out', rel = null } = {}) {
    const pick = (list, keyName, d) =>
      list.filter((e) => !rel || e.rel === rel).map((e) => ({ id: e[keyName], rel: e.rel, dir: d }));
    if (dir === 'out') return pick(this.out.get(id) || [], 'to', 'out');
    if (dir === 'in') return pick(this.in.get(id) || [], 'from', 'in');
    return [...pick(this.out.get(id) || [], 'to', 'out'), ...pick(this.in.get(id) || [], 'from', 'in')];
  }

  // Shortest path (BFS) over undirected edges.
  path(a, b) {
    if (!this.has(a) || !this.has(b)) return null;
    const prev = new Map([[a, null]]);
    const q = [a];
    while (q.length) {
      const cur = q.shift();
      if (cur === b) break;
      for (const { id } of this.neighbors(cur, { dir: 'both' })) {
        if (!prev.has(id)) {
          prev.set(id, cur);
          q.push(id);
        }
      }
    }
    if (!prev.has(b)) return null;
    const out = [];
    for (let n = b; n !== null; n = prev.get(n)) out.unshift(n);
    return out;
  }

  stats() {
    const byType = {};
    for (const n of this.nodes.values()) byType[n.type] = (byType[n.type] || 0) + 1;
    const byRel = {};
    for (const list of this.out.values()) for (const e of list) byRel[e.rel] = (byRel[e.rel] || 0) + 1;
    return { nodes: this.nodes.size, edges: this.edgeCount, byType, byRel };
  }

  toJSON() {
    const edges = [];
    for (const [from, list] of this.out) for (const e of list) edges.push([from, e.to, e.rel]);
    return { nodes: [...this.nodes.values()], edges };
  }

  save(path) {
    writeFileSync(path, JSON.stringify(this.toJSON()));
  }

  static load(path) {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    const g = new Graph();
    for (const n of data.nodes) {
      const { id, type, ...attrs } = n;
      g.addNode(id, type, attrs);
    }
    for (const [from, to, rel] of data.edges) g.addEdge(from, to, rel);
    return g;
  }
}

export default Graph;
