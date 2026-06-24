// Dependency-free Markdown parsing tuned for the Netwrix docs:
//   - YAML-ish frontmatter (scalars, quoted strings, block lists, folded scalars)
//   - heading extraction (with code-fence awareness)
//   - internal link + image collection
//   - heading-aware chunking with overlap for embeddings/retrieval
//
// This is intentionally small and predictable rather than a full CommonMark
// implementation — it only needs to understand the shapes these docs actually use.

import { config, estTokens } from '../config.mjs';

const FENCE = /^(```|~~~)/;

// --- Frontmatter -----------------------------------------------------------

export function parseFrontmatter(src) {
  if (!src.startsWith('---')) return { data: {}, body: src };
  const end = src.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: src };
  const raw = src.slice(3, end).replace(/^\r?\n/, '');
  const body = src.slice(end + 4).replace(/^\r?\n/, '');
  return { data: parseYamlish(raw), body };
}

function stripQuotes(v) {
  const s = v.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// Handles the subset of YAML used in these docs.
function parseYamlish(raw) {
  const lines = raw.split(/\r?\n/);
  const data = {};
  let key = null; // current key awaiting list items / folded text
  let mode = null; // 'list' | 'fold' | 'literal'
  let foldLines = [];

  const flushFold = () => {
    if (key && (mode === 'fold' || mode === 'literal')) {
      data[key] = mode === 'fold' ? foldLines.join(' ').trim() : foldLines.join('\n');
    }
    foldLines = [];
  };

  for (const line of lines) {
    if (!line.trim()) {
      if (mode === 'literal') foldLines.push('');
      continue;
    }
    const listItem = line.match(/^\s+-\s+(.*)$/);
    if (listItem && key && (mode === 'list' || data[key] === undefined)) {
      if (!Array.isArray(data[key])) data[key] = [];
      data[key].push(stripQuotes(listItem[1]));
      mode = 'list';
      continue;
    }
    const indented = line.match(/^\s+(\S.*)$/);
    if (indented && (mode === 'fold' || mode === 'literal')) {
      foldLines.push(indented[1]);
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w-]*):\s?(.*)$/);
    if (kv) {
      flushFold();
      key = kv[1];
      const val = kv[2];
      mode = null;
      if (val === '' || val === undefined) {
        // Could be a block list or just empty; default to empty string, lists fill in.
        data[key] = '';
      } else if (val.startsWith('>')) {
        mode = 'fold';
      } else if (val.startsWith('|')) {
        mode = 'literal';
      } else if (val.startsWith('[') && val.endsWith(']')) {
        data[key] = val
          .slice(1, -1)
          .split(',')
          .map((s) => stripQuotes(s))
          .filter(Boolean);
      } else {
        data[key] = stripQuotes(val);
      }
    }
  }
  flushFold();
  return data;
}

// --- Structure: headings, links, images ------------------------------------

export function slugifyHeading(text) {
  return text
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

const isInternal = (href) => {
  if (!href) return false;
  if (/^(https?:|mailto:|tel:|#)/i.test(href)) return false;
  return href.startsWith('/') || href.startsWith('.') || /\.(md|mdx)(#|$)/i.test(href);
};

export function extractStructure(body) {
  const lines = body.split(/\r?\n/);
  const headings = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m) {
      const text = m[2].replace(/[`*_]/g, '').trim();
      headings.push({ level: m[1].length, text, slug: slugifyHeading(text) });
    }
  }

  const links = new Set();
  for (const m of body.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const href = m[1].split('#')[0];
    if (isInternal(m[1]) && href) links.add(href);
  }

  const images = new Set();
  for (const m of body.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) images.add(m[1]);
  for (const m of body.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) images.add(m[1]);

  return { headings, links: [...links], images: [...images] };
}

// --- Chunking --------------------------------------------------------------

// Split body into heading-scoped sections, then window each section to ~maxChars
// with overlap. Each chunk is prefixed with a breadcrumb so embeddings capture
// where the passage sits in the document.
export function chunkBody(body, { title = '', maxChars, overlapChars } = {}) {
  maxChars = maxChars || config.chunk.maxChars;
  overlapChars = overlapChars || config.chunk.overlapChars;

  const lines = body.split(/\r?\n/);
  const sections = [];
  let crumbs = []; // [{level,text}]
  let buf = [];
  let inFence = false;

  const flush = () => {
    const text = buf.join('\n').trim();
    if (text) sections.push({ crumbs: crumbs.map((c) => c.text), text });
    buf = [];
  };

  for (const line of lines) {
    if (FENCE.test(line.trim())) inFence = !inFence;
    const h = !inFence && line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) {
      flush();
      const level = h[1].length;
      const text = h[2].replace(/[`*_]/g, '').trim();
      crumbs = crumbs.filter((c) => c.level < level);
      crumbs.push({ level, text });
      continue;
    }
    buf.push(line);
  }
  flush();

  const chunks = [];
  for (const sec of sections) {
    // Drop consecutive duplicate crumbs (common when a doc's H1 equals its title).
    const parts = [title, ...sec.crumbs].filter(Boolean);
    const breadcrumb = parts.filter((c, i) => i === 0 || c !== parts[i - 1]).join(' › ');
    for (const piece of windowText(sec.text, maxChars, overlapChars)) {
      const text = (breadcrumb ? breadcrumb + '\n\n' : '') + piece;
      if (text.trim().length < config.chunk.minChars) continue;
      chunks.push({ headingPath: sec.crumbs, text, tokens: estTokens(text) });
    }
  }
  // Whole-doc fallback if a doc had no headings and no body sections produced.
  if (chunks.length === 0 && body.trim()) {
    const text = (title ? title + '\n\n' : '') + body.trim().slice(0, maxChars);
    if (text.trim().length >= config.chunk.minChars) {
      chunks.push({ headingPath: [], text, tokens: estTokens(text) });
    }
  }
  return chunks;
}

// Window a long string into overlapping pieces, preferring paragraph boundaries.
function windowText(text, maxChars, overlapChars) {
  if (text.length <= maxChars) return [text];
  const paras = text.split(/\n{2,}/);
  const pieces = [];
  let cur = '';
  for (const p of paras) {
    if (p.length > maxChars) {
      if (cur) {
        pieces.push(cur);
        cur = '';
      }
      // Hard-split an oversized paragraph with overlap.
      for (let i = 0; i < p.length; i += maxChars - overlapChars) {
        pieces.push(p.slice(i, i + maxChars));
      }
      continue;
    }
    if ((cur + '\n\n' + p).length > maxChars) {
      if (cur) pieces.push(cur);
      // start new window, carrying a tail of the previous for context overlap
      const tail = cur.slice(Math.max(0, cur.length - overlapChars));
      cur = (tail ? tail + '\n\n' : '') + p;
    } else {
      cur = cur ? cur + '\n\n' + p : p;
    }
  }
  if (cur) pieces.push(cur);
  return pieces;
}

// One-shot parse of a full markdown source string.
export function parseMarkdown(src, opts = {}) {
  const { data, body } = parseFrontmatter(src);
  const title = data.title || opts.fallbackTitle || '';
  const struct = extractStructure(body);
  const chunks = chunkBody(body, { title });
  return { data, body, title, ...struct, chunks };
}

export default { parseFrontmatter, parseMarkdown, extractStructure, chunkBody, slugifyHeading };
