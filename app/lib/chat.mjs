// Generation layer (RAG answer) using Claude.
//
// Primary path: the official @anthropic-ai/sdk (recommended). If the package is
// not installed, it transparently falls back to a raw fetch() against the
// Messages API so the harness still works after a bare `node` checkout.
//
// Default model is cheap (claude-haiku-4-5); override with NDX_CHAT_MODEL or
// `--model claude-opus-4-8` for higher quality.

import { config } from '../config.mjs';
import { buildContext } from './retrieve.mjs';

const ADAPTIVE_THINKING = /^claude-(opus|sonnet)/; // haiku rejects thinking/effort params

const SYSTEM_PROMPT = `You are the Netwrix product documentation assistant.

Answer the user's question using ONLY the numbered context passages provided.
Rules:
- Cite the passages you use with their bracket markers, e.g. [1], [3].
- Netwrix ships many products and versions. When it matters, name the product and version your answer applies to.
- Knowledge Base (KB) passages are troubleshooting/how-to articles; prefer them for "error", "fails", "how do I fix" style questions, and prefer regular docs for conceptual/setup questions.
- If the context does not contain the answer, say so plainly and suggest which product/section to look in. Do not invent details.
- Be concise and concrete.`;

function textOf(resp) {
  return (resp.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

async function generate({ system, messages, model, maxTokens }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Generation (ask/chat) needs it; search/graph commands do not.'
    );
  }
  const params = { model, max_tokens: maxTokens, system, messages };
  if (ADAPTIVE_THINKING.test(model)) params.thinking = { type: 'adaptive' };

  try {
    const mod = await import('@anthropic-ai/sdk');
    const Anthropic = mod.default || mod.Anthropic;
    const client = new Anthropic();
    const resp = await client.messages.create(params);
    return textOf(resp);
  } catch (e) {
    const missing = /ERR_MODULE_NOT_FOUND|Cannot find package|Cannot find module/.test(String(e && e.message));
    if (!missing) throw e;
    // Fallback: raw HTTP (no SDK installed)
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(params),
    });
    if (!r.ok) throw new Error(`Anthropic API ${r.status}: ${await r.text()}`);
    return textOf(await r.json());
  }
}

// One-shot RAG answer. `hits` come from retrieve().
export async function answer(question, hits, opts = {}) {
  const model = opts.model || config.chat.model;
  const maxTokens = opts.maxTokens || config.chat.maxTokens;
  const { text: ctx, sources } = buildContext(hits);
  const messages = [
    { role: 'user', content: `Context passages:\n\n${ctx}\n\n========\nQuestion: ${question}` },
  ];
  const reply = await generate({ system: SYSTEM_PROMPT, messages, model, maxTokens });
  return { reply, sources, model };
}

// Multi-turn helper for the chat REPL: caller maintains `history` (role/content).
export async function answerWithHistory(question, hits, history, opts = {}) {
  const model = opts.model || config.chat.model;
  const maxTokens = opts.maxTokens || config.chat.maxTokens;
  const { text: ctx, sources } = buildContext(hits);
  const messages = [
    ...history,
    { role: 'user', content: `Context passages:\n\n${ctx}\n\n========\nQuestion: ${question}` },
  ];
  const reply = await generate({ system: SYSTEM_PROMPT, messages, model, maxTokens });
  return { reply, sources, model, userMessage: messages[messages.length - 1] };
}

export default { answer, answerWithHistory };
