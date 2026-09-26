// scripts/fuzz.mjs — 随机模型交叉验证
// 参照判据（与 diagnose() 的 SCC 扫描独立实现）：
//   在增强图 H 上工作，节点 = (verifier 状态 s, 双侧移动掩码 mask)。
//   不可诊断 ⇔ 存在从初态可达的节点 h=(s,3) 且 s.f=1，
//   并且 h 能经非空路径回到自身（即存在 mask 累积为 3 的闭合游走）。
import { parseSpec } from '../src/parser.mjs';
import { diagnose, buildVerifier, tarjan, delayAudit } from '../src/diagnoser.mjs';

// 独立 Kosaraju SCC，仅用于核对 tarjan 的同分量等价关系
function kosarajuComponents(vs) {
  const mark = new Set();
  const order = [];
  const dfs1 = (s) => {
    const st = [s];
    const it = new Map();
    mark.add(s);
    while (st.length) {
      const u = st[st.length - 1];
      let i = it.get(u) ?? 0;
      while (i < u.edges.length && mark.has(u.edges[i].to)) i++;
      if (i < u.edges.length) {
        const w = u.edges[i].to;
        it.set(u, i + 1);
        mark.add(w); st.push(w);
      } else {
        order.push(u); st.pop();
      }
    }
  };
  for (const s of vs) if (!mark.has(s)) dfs1(s);
  const pred = new Map(vs.map((s) => [s, []]));
  for (const s of vs) for (const e of s.edges) pred.get(e.to).push(s);
  const comp = new Map();
  let cid = 0;
  for (let k = order.length - 1; k >= 0; k--) {
    const root = order[k];
    if (comp.has(root)) continue;
    const st = [root];
    comp.set(root, cid);
    while (st.length) {
      const u = st.pop();
      for (const w of pred.get(u)) {
        if (!comp.has(w)) { comp.set(w, cid); st.push(w); }
      }
    }
    cid++;
  }
  return comp;
}

let sccChecks = 0;
function assertSccAgree(model) {
  const v = buildVerifier(model);
  const { compOf } = tarjan(v.states);
  const ref = kosarajuComponents(v.states);
  for (const a of v.states) {
    for (const b of v.states) {
      const sameT = compOf.get(a) === compOf.get(b);
      const sameK = ref.get(a) === ref.get(b);
      if (sameT !== sameK) {
        throw new Error(`SCC 划分分歧: states ${a.id} ${b.id}`);
      }
    }
  }
  sccChecks++;
}

function reference(model) {
  const v = buildVerifier(model);
  // 可达 verifier 状态
  const reach = new Set([v.start]);
  const q0 = [v.start];
  while (q0.length) {
    const s = q0.shift();
    for (const e of s.edges) if (!reach.has(e.to)) { reach.add(e.to); q0.push(e.to); }
  }
  const nk = (s, mask) => `${s.id}:${mask}`;
  const succMask = (s, mask) => s.edges.map((e) => ({
    to: e.to,
    mask: mask | (e.fTrans ? 1 : 0) | (e.nTrans ? 2 : 0),
  }));
  // 对每个可达 f=1 状态 s：在增强图上找从 (s,0) 出发、非空回到某个
  // (s',3)（s'=s）的闭合游走——掩码必须在【闭环内部】累积到 3，
  // 前缀中发生过的双侧移动不算。
  for (const s of v.states) {
    if (s.f !== 1 || !reach.has(s)) continue;
    const depth = new Map([[nk(s, 0), 0]]);
    const q = [{ s, mask: 0, d: 0 }];
    while (q.length) {
      const n = q.shift();
      for (const m of succMask(n.s, n.mask)) {
        if (m.to === s && m.mask === 3) return true;
        const k = nk(m.to, m.mask);
        if (!depth.has(k)) { depth.set(k, n.d + 1); q.push({ s: m.to, mask: m.mask, d: n.d + 1 }); }
      }
    }
  }
  return false;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomModel(rand, n) {
  const locs = Array.from({ length: n }, (_, i) => `L${i}`);
  const lines = [`init ${locs[0]}`, ...locs.map((l) => `loc ${l}`)];
  let id = 0;
  for (const src of locs) {
    const deg = 1 + Math.floor(rand() * 3);
    for (let k = 0; k < deg; k++) {
      const dst = locs[Math.floor(rand() * n)];
      const kind = rand() < 0.28 ? 'F' : 'N';
      const rec = rand() < 0.3
        ? 'SILENT'
        : ['a', 'b', 'c'][Math.floor(rand() * 3)];
      lines.push(`trans t${id++} ${src} ${dst} ${kind} ${rec}`);
    }
  }
  return lines.join('\n');
}

let seed = Number(process.argv[2] ?? 1);
const count = Number(process.argv[3] ?? 3000);
let mismatches = 0;
let nonDiag = 0;

// 独立参照：延迟审计参照实现（与生产代码的 SCC-DAG DP 完全独立）。
//   1) 用“反复删出度 0 位置”的独立实现求活位置；
//   2) 枚举 f:0→1 的置位边；
//   3) 双侧皆活 verifier 子图上，检测 SYNC 环（独立 DFS 三色）；
//   4) 有限时用迭代松弛（Bellman–Ford 风格）求每个种子的最长 SYNC 路径。
function referenceDelay(model) {
  const v = buildVerifier(model);
  const locSucc = (normalOnly) => {
    const m = new Map(model.locations.map((l) => [l, []]));
    for (const t of model.transitions) {
      if (normalOnly && t.faulty) continue;
      m.get(t.src).push(t.dst);
    }
    return m;
  };
  const liveSet = (normalOnly) => {
    const s = locSucc(normalOnly);
    const od = new Map([...s.keys()].map((k) => [k, s.get(k).length]));
    const pred = new Map([...s.keys()].map((k) => [k, []]));
    for (const [u, ws] of s) for (const w of ws) {
      if (!pred.has(w)) pred.set(w, []);
      if (!od.has(w)) od.set(w, 0);
      pred.get(w).push(u);
    }
    const seenDead = new Set();
    const q = [...od].filter(([, d]) => d === 0).map(([l]) => l);
    for (let h = 0; h < q.length; h++) {
      const u = q[h];
      if (seenDead.has(u)) continue;
      seenDead.add(u);
      for (const p of pred.get(u) ?? []) {
        if (seenDead.has(p)) continue;
        od.set(p, od.get(p) - 1);
        if (od.get(p) === 0) q.push(p);
      }
    }
    return new Set([...s.keys()].filter((l) => !seenDead.has(l)));
  };
  const lf = liveSet(false);
  const ln = liveSet(true);
  const good = (s) => lf.has(s.p) && ln.has(s.q);

  const seeds0 = [];
  for (const s of v.states) if (s.f === 0) {
    for (const e of s.edges) if (e.fTrans?.faulty && e.to.f === 1) seeds0.push({ from: s, e, to: e.to });
  }
  const reach0 = new Set([v.start]);
  {
    const q = [v.start];
    for (let h = 0; h < q.length; h++) for (const e of q[h].edges)
      if (!reach0.has(e.to)) { reach0.add(e.to); q.push(e.to); }
  }
  const liveSeeds = seeds0.filter((sd) => good(sd.to) && reach0.has(sd.to));

  // 子图邻接（双侧皆活）
  const sub = (s) => good(s) ? s.edges.filter((e) => good(e.to)) : [];

  // 从活种子可达的子图 R
  const R = new Set();
  {
    const q = liveSeeds.map((sd) => sd.to);
    for (const s of q) R.add(s);
    for (let h = 0; h < q.length; h++) for (const e of sub(q[h]))
      if (!R.has(e.to)) { R.add(e.to); q.push(e.to); }
  }

  // 独立无界判据：R 中存在某状态 t，增强空间 (t, mask) 上有【非空】路径
  // 回到 (t, 3)——环内既移动故障副本又移动正常副本（与生产代码的 SCC
  // movesF&&movesN 判据独立；SYNC 环与“双侧各静默环”都由此捕获）。
  const nk = (s, mask) => `${s.id}:${mask}`;
  let unbounded = false;
  for (const t of v.states) {
    if (!R.has(t)) continue;
    const depth = new Map([[nk(t, 0), 0]]);
    const q = [{ s: t, mask: 0 }];
    for (let h = 0; h < q.length; h++) {
      const n = q[h];
      for (const e of sub(n.s)) {
        if (!R.has(e.to)) continue;
        const mask = n.mask | (e.fTrans ? 1 : 0) | (e.nTrans ? 2 : 0);
        if (e.to === t && mask === 3) { unbounded = true; break; }
        const k = nk(e.to, mask);
        if (!depth.has(k)) { depth.set(k, depth.size); q.push({ s: e.to, mask }); }
      }
      if (unbounded) break;
    }
    if (unbounded) break;
  }

  if (unbounded) return { finite: false };

  if (liveSeeds.length === 0) return { finite: true, delays: [], globalDelay: 0 };

  const rStates = v.states.filter((s) => R.has(s));
  const edgesR = [];
  for (const s of rStates) for (const e of sub(s)) if (R.has(e.to)) edgesR.push({ s, e });

  // 迭代松弛最长路（Bellman–Ford 风格）：每个活种子独立计算最长 SYNC 计数。
  // 无正权环（否则上面已判无界），静默环权 0 不增长，≤ |R| 轮必然收敛。
  const perSeed = liveSeeds.map((sd) => {
    const dist = new Map([[sd.to.id, 0]]);
    for (let pass = 0; pass < rStates.length; pass++) {
      let changed = false;
      for (const { s, e } of edgesR) {
        const du = dist.get(s.id);
        if (du === undefined) continue;
        const w = e.mode === 'SYNC' ? 1 : 0;
        const dv = dist.get(e.to.id) ?? -1;
        if (du + w > dv) { dist.set(e.to.id, du + w); changed = true; }
      }
      if (!changed) break;
    }
    let best = 0;
    for (const d of dist.values()) if (d > best) best = d;
    return best;
  });
  return { finite: true, delays: perSeed, globalDelay: Math.max(0, ...perSeed) };
}

let delayMismatch = 0;
let delayChecked = 0;
let delayBoundedChecked = 0;

for (let i = 0; i < count; i++) {
  const rand = rng(seed++);
  const n = 2 + Math.floor(rand() * 4);
  const text = randomModel(rand, n);
  const model = parseSpec(text);
  if (model.errors.length) continue;
  assertSccAgree(model);
  const got = !diagnose(model).diagnosable;
  const want = reference(model);
  if (got) nonDiag++;
  if (got !== want) {
    mismatches++;
    if (mismatches <= 5) {
      console.log('MISMATCH seed=', seed - 1, 'got(不可诊断)=', got, 'want=', want);
      console.log(text);
      console.log('---');
    }
  }

  // 延迟审计交叉验证（只对可诊断模型比较有限延迟；不可诊断模型必须报无界）
  const a = delayAudit(model);
  const ref = referenceDelay(model);
  delayChecked++;
  if (got) {
    if (a.finite) {
      delayMismatch++;
      if (delayMismatch <= 5) console.log('DELAY MISMATCH(应无界) seed=', seed - 1);
    }
  } else if (!ref.finite) {
    delayMismatch++;
    if (delayMismatch <= 5) console.log('DELAY MISMATCH(参照无界但实现有限) seed=', seed - 1);
  } else {
    delayBoundedChecked++;
    if (a.finite !== true || a.delay !== ref.globalDelay) {
      delayMismatch++;
      if (delayMismatch <= 5) {
        console.log('DELAY MISMATCH seed=', seed - 1, 'impl=', a.finite ? a.delay : 'inf',
          'ref=', ref.globalDelay, 'perSeed=', JSON.stringify(ref.delays));
        console.log(text);
        console.log('---');
      }
    }
  }
}
console.log(`fuzz: ${count} models (${nonDiag} non-diagnosable), ${mismatches} diagnosability mismatches`);
console.log(`fuzz: delay audit checked on ${delayChecked} models ` +
  `(${delayBoundedChecked} bounded), ${delayMismatch} delay mismatches`);
process.exit(mismatches || delayMismatch ? 1 : 0);
