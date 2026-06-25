// Builders for the text that represents a Document or a Heading in their
// respective embedding spaces.
//
// KB articles and regular docs are deliberately treated differently:
//   - Regular docs carry a `description` + a heading outline + a lead paragraph.
//   - KB articles additionally carry rich frontmatter (`keywords`, `tags`) and a
//     Symptom/Cause/Resolution body — all highly semantic — so we fold those in.

import { config } from '../config.mjs';

const cap = (s, n) => {
  s = (s || '').trim();
  return s.length > n ? s.slice(0, n) : s;
};
const list = (v) => (Array.isArray(v) ? v.filter(Boolean) : v ? [v] : []);

// Whole-document representation. `data` is the parsed frontmatter.
export function docEmbedText({ title, description, tier, data = {}, headings = [], preamble = '', sections = [] }) {
  const max = config.doc.maxChars;
  const parts = [];
  if (title) parts.push(title);
  if (description) parts.push(description);

  if (tier === 'kb') {
    const kws = list(data.keywords);
    if (kws.length) parts.push('Keywords: ' + kws.join(', '));
    const tags = list(data.tags);
    if (tags.length) parts.push('Tags: ' + tags.join(', '));
  }

  const outline = headings.map((h) => h.text).filter(Boolean).slice(0, 40);
  if (outline.length) parts.push('Sections: ' + outline.join(' · '));

  // KB bodies are short and information-dense (symptom/cause/resolution) — take more of it.
  const lead = preamble || (sections[0] && sections[0].body) || '';
  if (lead) parts.push(cap(lead, tier === 'kb' ? 900 : 600));

  return cap(parts.join('\n'), max);
}

// One heading's section. `crumbs` are the ancestor heading texts.
export function headingEmbedText({ title, crumbs = [], heading, body = '' }) {
  const max = config.heading.maxChars;
  const trail = [title, ...crumbs, heading].filter(Boolean);
  const breadcrumb = trail.filter((c, i) => i === 0 || c !== trail[i - 1]).join(' › ');
  const text = body ? `${breadcrumb}\n${cap(body, max)}` : breadcrumb;
  return cap(text, max + breadcrumb.length + 1);
}

export default { docEmbedText, headingEmbedText };
