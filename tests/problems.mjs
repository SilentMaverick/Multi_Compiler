import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PROBLEMS } = require('../src/problems.js');

// Independent reference implementations, used only to validate the stored answers.
const solvers = {
  'two-sum'(input) {
    const d = input.trim().split(/\s+/).map(Number);
    const [n, target] = d;
    const a = d.slice(2, 2 + n);
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) if (a[i] + a[j] === target) return `${i} ${j}`;
    return '-1';
  },
  'max-subarray'(input) {
    const d = input.trim().split(/\s+/).map(Number);
    const n = d[0];
    const a = d.slice(1, 1 + n);
    let best = -Infinity, run = 0;
    for (const x of a) {
      run = run > 0 ? run + x : x;
      best = Math.max(best, run);
    }
    return String(best);
  },
  'valid-parentheses'(input) {
    const s = input.replace(/\r?\n$/, '').replace(/\n$/, '');
    const pairs = { ')': '(', ']': '[', '}': '{' };
    const st = [];
    for (const c of s) {
      if (c === '(' || c === '[' || c === '{') st.push(c);
      else if (pairs[c]) {
        if (st.pop() !== pairs[c]) return 'NO';
      } else return 'NO';
    }
    return st.length ? 'NO' : 'YES';
  },
  fibonacci(input) {
    const MOD = 1000000007n;
    const n = Number(input.trim());
    let a = 0n, b = 1n;
    for (let i = 0; i < n; i++) {
      const t = (a + b) % MOD;
      a = b;
      b = t;
    }
    return String(a);
  },
  'binary-search'(input) {
    const d = input.trim().split(/\s+/).map(Number);
    const [n, q] = d;
    const a = d.slice(2, 2 + n);
    const queries = d.slice(2 + n, 2 + n + q);
    return queries
      .map((x) => {
        let lo = 0, hi = n - 1, found = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (a[mid] === x) { found = mid; break; }
          if (a[mid] < x) lo = mid + 1; else hi = mid - 1;
        }
        return found;
      })
      .join('\n');
  },
  'longest-substring'(input) {
    const s = input.replace(/\r?\n$/, '');
    const last = new Map();
    let best = 0, start = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (last.has(c) && last.get(c) >= start) start = last.get(c) + 1;
      last.set(c, i);
      best = Math.max(best, i - start + 1);
    }
    return String(best);
  },
};

const norm = (s) => String(s).replace(/\r\n/g, '\n').trim();

let bad = 0;
for (const p of PROBLEMS) {
  const solver = solvers[p.id];
  if (!solver) {
    console.log(`  ? no validator for ${p.id}`);
    bad++;
    continue;
  }
  const cases = [...p.samples.map((c, i) => ({ ...c, kind: `sample ${i + 1}` })), ...p.hidden.map((c, i) => ({ ...c, kind: `hidden ${i + 1}` }))];
  for (const c of cases) {
    const got = solver(c.input);
    const ok = norm(got) === norm(c.expected);
    if (!ok) {
      bad++;
      console.log(`  [FAIL] ${p.id} ${c.kind}`);
      console.log(`         input:    ${JSON.stringify(c.input)}`);
      console.log(`         stored:   ${JSON.stringify(c.expected)}`);
      console.log(`         computed: ${JSON.stringify(got)}`);
    }
  }
  console.log(`  ${p.id}: ${cases.length} cases checked`);
}

// every starter must at least compile/run in python (fast sanity check of syntax)
console.log(bad ? `\n  ${bad} WRONG EXPECTED OUTPUT(S)` : '\n  all expected outputs verified');
process.exit(bad ? 1 : 0);
