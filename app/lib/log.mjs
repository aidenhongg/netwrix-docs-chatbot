// Tiny logging / formatting helpers. No dependencies.

const t0 = Date.now();
const ms = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

export const log = (...a) => console.error(`[ndx ${ms()}]`, ...a);
export const out = (...a) => console.log(...a); // user-facing stdout (answers, results)

// In-place progress line on stderr (won't pollute stdout/answers).
export function progress(msg) {
  if (process.stderr.isTTY) {
    process.stderr.write(`\r\x1b[2K[ndx ${ms()}] ${msg}`);
  }
}
export function progressDone(msg) {
  if (process.stderr.isTTY) process.stderr.write('\r\x1b[2K');
  if (msg) log(msg);
}

export const fmtInt = (n) => Number(n).toLocaleString('en-US');
export const fmtBytes = (n) => {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)}${u[i]}`;
};
