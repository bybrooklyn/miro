// A unified diff for the plan the user approves (PLAN.md client decision: file changes render as
// a real diff). Line-based LCS — O(n·m) memory on the two files' line counts, fine for config
// files; a config file that is not fine here is not something to eyeball-approve anyway.
// ponytail: no Myers, no word-level; upgrade if a real plan ever hits the cap below.

const MAX_LINES = 4000;

export function unifiedDiff(before: string, after: string, path: string, context = 3): string {
  const a = before.length === 0 ? [] : before.split("\n");
  const b = after.length === 0 ? [] : after.split("\n");
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return `--- ${path}\n+++ ${path}\n@@ file too large to diff (${a.length} → ${b.length} lines) @@\n`;
  }
  // LCS table.
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  // Walk to an edit script.
  type Op = { kind: " " | "-" | "+"; line: string; ai: number; bi: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) ops.push({ kind: " ", line: a[i], ai: i++, bi: j++ });
    else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) ops.push({ kind: "-", line: a[i], ai: i++, bi: j }); // removals first, as diff(1) does
    else ops.push({ kind: "+", line: b[j], ai: i, bi: j++ });
  }
  if (!ops.some((o) => o.kind !== " ")) return "";

  // Group into hunks with `context` lines around changes.
  const out: string[] = [`--- ${path}`, `+++ ${path}`];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].kind === " ") { k++; continue; }
    const start = Math.max(0, k - context);
    let end = k;
    let last = k;
    while (end < ops.length) {
      if (ops[end].kind !== " ") last = end;
      else if (end - last > context * 2) break;
      end++;
    }
    end = Math.min(ops.length, last + context + 1);
    const hunk = ops.slice(start, end);
    const aStart = (hunk.find((o) => o.kind !== "+")?.ai ?? hunk[0].ai) + 1;
    const bStart = (hunk.find((o) => o.kind !== "-")?.bi ?? hunk[0].bi) + 1;
    const aLen = hunk.filter((o) => o.kind !== "+").length;
    const bLen = hunk.filter((o) => o.kind !== "-").length;
    out.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`);
    for (const o of hunk) out.push(`${o.kind}${o.line}`);
    k = end;
  }
  return out.join("\n") + "\n";
}
