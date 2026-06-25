// Minimal in-memory BM25 over an item corpus (id + text). Zero dependencies.
// Provides the lexical signal that the hybrid ranking function fuses with vectors,
// so there is something real to tune (vector vs lexical vs fusion).

const tokenize = (s) => String(s).toLowerCase().match(/[a-z0-9]+/g) || [];

export class BM25 {
  constructor(items, { k1 = 1.5, b = 0.75 } = {}) {
    this.k1 = k1;
    this.b = b;
    this.N = items.length;
    this.ids = new Array(this.N);
    this.len = new Float64Array(this.N);
    this.df = new Map(); // term -> document frequency
    this.postings = new Map(); // term -> [[docIdx, tf], ...]
    let total = 0;
    for (let i = 0; i < this.N; i++) {
      this.ids[i] = items[i].id;
      const toks = tokenize(items[i].text);
      this.len[i] = toks.length;
      total += toks.length;
      const tf = new Map();
      for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
      for (const [t, c] of tf) {
        let p = this.postings.get(t);
        if (!p) {
          p = [];
          this.postings.set(t, p);
          this.df.set(t, 0);
        }
        p.push([i, c]);
        this.df.set(t, this.df.get(t) + 1);
      }
    }
    this.avgdl = total / Math.max(1, this.N);
  }

  search(query, k = 200) {
    const qToks = [...new Set(tokenize(query))];
    const scores = new Map(); // docIdx -> score
    for (const t of qToks) {
      const post = this.postings.get(t);
      if (!post) continue;
      const df = this.df.get(t);
      const idf = Math.log(1 + (this.N - df + 0.5) / (df + 0.5));
      for (const [i, tf] of post) {
        const denom = tf + this.k1 * (1 - this.b + (this.b * this.len[i]) / this.avgdl);
        scores.set(i, (scores.get(i) || 0) + idf * ((tf * (this.k1 + 1)) / denom));
      }
    }
    const arr = [];
    for (const [i, s] of scores) arr.push({ id: this.ids[i], score: s });
    arr.sort((a, b) => b.score - a.score);
    return arr.slice(0, k);
  }
}

export default { BM25 };
