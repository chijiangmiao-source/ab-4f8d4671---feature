// diagnoser.mjs — 静默 DES 的故障可诊断性判定（verifier / twin-plant）
//
// 精确判定命题：
//   是否存在两条无限执行 πF（经过至少一条 F 迁移）与 πN（从不经过 F 迁移），
//   二者的可观察回执序列（剔除 SILENT 后的 ASCII 回执）逐元素完全相同。
// 存在 ⇒ 故障可被正常执行无限期伪装 ⇒ 不可诊断（NOT_DIAGNOSABLE）。
//
// verifier 状态 = (p, q, f)
//   p：故障副本（完整自动机）所在位置；q：正常副本（删除全部 F 迁移）所在位置
//   f=1：故障副本已经走过某条 F 迁移；f=0：尚未。
// 三类边（正常副本永不走 F）：
//   SYNC     两侧各走一条非静默、回执相同的迁移；故障副本取 F 时 f 置 1
//   F_SILENT 故障副本单独走一条 SILENT 迁移（F 时 f 置 1）
//   N_SILENT 正常副本单独走一条 SILENT 的 N 迁移，f 不变
//
// 不可诊断 ⇔ 从初态可达的某个 f=1 SCC 中，存在一条“合格闭环”：
// 闭环内既有移动故障副本的边、又有移动正常副本的边（因此闭环重复时
// 两侧都是无限执行；仅故障副本静默自环、正常侧停滞不算）。

export function buildVerifier(model) {
  const { init, transitions } = model;
  const out = new Map();
  for (const t of transitions) {
    if (!out.has(t.src)) out.set(t.src, []);
    out.get(t.src).push(t);
  }
  const from = (p) => out.get(p) ?? [];

  const states = new Map();
  const get = (p, q, f) => {
    const k = `${p} ${q} ${f}`;
    let s = states.get(k);
    if (!s) {
      s = { id: states.size, p, q, f, edges: [] };
      states.set(k, s);
    }
    return s;
  };

  let edgeSeq = 0;
  const addEdge = (s, ns, edge) => {
    s.edges.push({ seq: edgeSeq++, ...edge, to: ns });
    if (!ns.enqueued) { ns.enqueued = true; queue.push(ns); }
  };

  const start = get(init, init, 0);
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const s = queue[head];
    const a = from(s.p);
    const b = from(s.q);

    // F_SILENT：故障副本单独静默（F 或 N）
    for (const x of a) {
      if (!x.silent) continue;
      const ns = get(x.dst, s.q, s.f | (x.faulty ? 1 : 0));
      addEdge(s, ns, { mode: 'F_SILENT', fTrans: x, nTrans: null, receipt: null });
    }

    // N_SILENT：正常副本单独静默（只能是 N）
    for (const y of b) {
      if (!y.silent || y.faulty) continue;
      const ns = get(s.p, y.dst, s.f);
      addEdge(s, ns, { mode: 'N_SILENT', fTrans: null, nTrans: y, receipt: null });
    }

    // SYNC：双侧非静默、回执相同；正常副本只能走 N
    for (const x of a) {
      if (x.silent) continue;
      for (const y of b) {
        if (y.silent || y.faulty || x.receipt !== y.receipt) continue;
        const ns = get(x.dst, y.dst, s.f | (x.faulty ? 1 : 0));
        addEdge(s, ns, { mode: 'SYNC', fTrans: x, nTrans: y, receipt: x.receipt });
      }
    }
  }

  return { states: [...states.values()], start };
}

// 迭代式 Tarjan SCC（显式栈，避免 verifier 状态数万时递归栈溢出）
// adjOf 可给出子图邻接（延迟审计只在“两侧皆活”的子图上求 SCC）。
export function tarjan(vs, adjOf = (s) => s.edges) {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const idx = new Map();
  const low = new Map();
  const compOf = new Map();
  const comps = [];

  for (const root of vs) {
    if (idx.has(root)) continue;
    // 栈帧：{ v, i }（i 为下一条待处理出边下标）
    const callStack = [{ v: root, i: 0 }];
    idx.set(root, index); low.set(root, index); index++;
    stack.push(root); onStack.add(root);

    while (callStack.length) {
      const frame = callStack[callStack.length - 1];
      const v = frame.v;
      const edges = adjOf(v);
      if (frame.i < edges.length) {
        const w = edges[frame.i++].to;
        if (!idx.has(w)) {
          idx.set(w, index); low.set(w, index); index++;
          stack.push(w); onStack.add(w);
          callStack.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v), idx.get(w)));
        }
      } else {
        // 出边处理完毕：若是某父帧的树子节点，向父帧传播 lowlink
        if (low.get(v) === idx.get(v)) {
          const cid = comps.length;
          const members = [];
          let w;
          do {
            w = stack.pop();
            onStack.delete(w);
            compOf.set(w, cid);
            members.push(w);
          } while (w !== v);

          const memberIds = new Set(members.map((m) => m.id));
          let movesF = false, movesN = false;
          for (const m of members) {
            for (const e of m.edges) {
              if (!memberIds.has(e.to.id)) continue;
              if (e.fTrans) movesF = true;
              if (e.nTrans) movesN = true;
            }
          }
          comps.push({ id: cid, members, movesF, movesN });
        }
        callStack.pop();
        const parent = callStack[callStack.length - 1];
        // 树子节点（仍在 Tarjan 栈上才传播；已单独成 SCC 的不传播）
        if (parent && onStack.has(v)) {
          low.set(parent.v, Math.min(low.get(parent.v), low.get(v)));
        }
      }
    }
  }
  return { compOf, comps };
}

function reachable(start) {
  const seen = new Set([start]);
  const q = [start];
  for (let h = 0; h < q.length; h++) {
    for (const e of q[h].edges) {
      if (!seen.has(e.to)) { seen.add(e.to); q.push(e.to); }
    }
  }
  return seen;
}

const edgeKey = (e) =>
  `${e.fTrans?.id ?? ''}|${e.nTrans?.id ?? ''}|${e.mode}`;
const recvCount = (edges) => edges.filter((e) => e.receipt !== null).length;
const pathKey = (edges) => edges.map(edgeKey).join(',');
const edgeWeight = (e) => (e.mode === 'SYNC' ? 1 : 0);

// 简易二叉堆，按 (cost, key) 排序
function heap() {
  const a = [];
  const less = (x, y) => x[0] - y[0] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0);
  const up = (i) => {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (less(a[i], a[p]) < 0) { [a[i], a[p]] = [a[p], a[i]]; i = p; } else break;
    }
  };
  const down = (i) => {
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < a.length && less(a[l], a[m]) < 0) m = l;
      if (r < a.length && less(a[r], a[m]) < 0) m = r;
      if (m === i) break;
      [a[i], a[m]] = [a[m], a[i]];
      i = m;
    }
  };
  return {
    push: (item) => { a.push(item); up(a.length - 1); },
    pop: () => { const t = a[0], l = a.pop(); if (a.length) { a[0] = l; down(0); } return t; },
    get size() { return a.length; },
  };
}

// 全目标 Dijkstra：返回每个可达节点的最优记录（cost 最小，平局路径标识键最小）
function dijkstraAll(start) {
  const h = heap();
  const best = new Map();
  const startRec = { cost: 0, parent: null, node: start, pathKey: '' };
  best.set(start.id, startRec);
  h.push([0, start, '']);
  while (h.size) {
    const [cost, node] = h.pop();
    const rec = best.get(node.id);
    if (!rec || rec.cost !== cost) continue; // 过期堆条目
    for (const e of node.edges) {
      const ncost = cost + edgeWeight(e);
      const nkey = rec.pathKey + edgeKey(e) + ',';
      const known = best.get(e.to.id);
      if (!known || ncost < known.cost ||
          (ncost === known.cost && nkey < known.pathKey)) {
        const nr = { cost: ncost, parent: { rec, edge: e }, node: e.to, pathKey: nkey };
        best.set(e.to.id, nr);
        h.push([ncost, e.to, nkey]);
      }
    }
  }
  return best;
}

function recToEdges(rec) {
  const edges = [];
  for (let r = rec; r.parent; r = r.parent.rec) edges.push(r.parent.edge);
  return edges.reverse();
}

// 初态到目标 verifier 状态的最短通路（静默权 0、同步权 1）
function shortestPath(allBest, start, goal) {
  if (start === goal) return [];
  const rec = allBest.get(goal.id);
  return rec ? recToEdges(rec) : null;
}

// 合格闭环：s 出发回到 s，只走 cid 分量内部边，且闭环中
// 至少一条移动故障副本的边、一条移动正常副本的边（mask=3）。
// 在增强空间 (verifier 状态, mask) 上做 Dijkstra，目标 (s,3)。
function qualifyingCycle(s, compOf, cid) {
  const startNode = { vs: s, mask: 0 };
  const keyOf = (n) => n.vs.id * 4 + n.mask;
  const h = heap();
  const best = new Map();
  const startRec = { cost: 0, parent: null, node: startNode, pathKey: '' };
  best.set(keyOf(startNode), startRec);
  h.push([0, startNode, '']);
  let goalRec = null;
  while (h.size) {
    const [cost, node] = h.pop();
    const rec = best.get(keyOf(node));
    if (!rec || rec.cost !== cost) continue;
    if (node.vs === s && node.mask === 3) { goalRec = rec; break; }
    for (const e of node.vs.edges) {
      if (compOf.get(e.to) !== cid) continue;
      const next = {
        vs: e.to,
        mask: node.mask | (e.fTrans ? 1 : 0) | (e.nTrans ? 2 : 0),
      };
      const ncost = cost + edgeWeight(e);
      const nkey = rec.pathKey + edgeKey(e) + ',';
      const known = best.get(keyOf(next));
      if (!known || ncost < known.cost ||
          (ncost === known.cost && nkey < known.pathKey)) {
        const nr = { cost: ncost, parent: { rec, edge: e }, node: next, pathKey: nkey };
        best.set(keyOf(next), nr);
        h.push([ncost, next, nkey]);
      }
    }
  }
  if (!goalRec) return null;
  return recToEdges(goalRec);
}

export function diagnose(model) {
  const v = buildVerifier(model);
  const { compOf, comps } = tarjan(v.states);
  const fromStart = reachable(v.start);

  // 合格歧义 SCC：可达、f=1、内部同时能移动两侧（含两侧无限执行的闭环）
  const ambiguous = v.states.filter((s) => {
    if (s.f !== 1 || !fromStart.has(s)) return false;
    const c = comps[compOf.get(s)];
    return c.movesF && c.movesN;
  });

  const checkedPairs = v.states
    .filter((s) => s.f === 1 && fromStart.has(s))
    .map((s) => {
      const c = comps[compOf.get(s)];
      let verdict;
      if (c.movesF && c.movesN) verdict = 'ambiguous';
      else if (!c.movesF && !c.movesN) verdict = 'acyclic';
      else if (!c.movesN) verdict = 'normal-side-stalls';
      else verdict = 'fault-side-stalls';
      return { p: s.p, q: s.q, movesF: c.movesF, movesN: c.movesN, verdict };
    })
    .sort((a, b) => a.p.localeCompare(b.p) || a.q.localeCompare(b.q));

  if (ambiguous.length === 0) {
    return {
      diagnosable: true,
      verifierStateCount: v.states.length,
      witness: null,
      checkedPairs,
    };
  }

  // 公共前缀只算一次（全目标最短路径）
  const allBest = dijkstraAll(v.start);

  // 按合格 SCC 分组。裁决先比前缀回执长度：每个 SCC 只需考察
  // “前缀最短”的入口（平局通常唯一），再在其上求最短合格闭环。
  const byComp = new Map();
  for (const s of ambiguous) {
    const cid = compOf.get(s);
    if (!byComp.has(cid)) byComp.set(cid, []);
    byComp.get(cid).push(s);
  }

  const candidates = [];
  for (const [cid, members] of byComp) {
    let minCost = Infinity;
    for (const s of members) {
      const c = allBest.get(s.id)?.cost ?? Infinity;
      if (c < minCost) minCost = c;
    }
    for (const s of members) {
      if ((allBest.get(s.id)?.cost ?? Infinity) !== minCost) continue;
      const prefix = shortestPath(allBest, v.start, s);
      const loop = qualifyingCycle(s, compOf, cid);
      if (prefix && loop) {
        candidates.push({ entry: { p: s.p, q: s.q }, prefix, loop });
      }
    }
  }
  candidates.sort((a, b) => {
    const d1 = recvCount(a.prefix) - recvCount(b.prefix);
    if (d1 !== 0) return d1;
    const d2 = recvCount(a.loop) - recvCount(b.loop);
    if (d2 !== 0) return d2;
    return `${pathKey(a.prefix)}#${pathKey(a.loop)}`.localeCompare(
      `${pathKey(b.prefix)}#${pathKey(b.loop)}`);
  });

  const win = candidates[0];
  return {
    diagnosable: false,
    verifierStateCount: v.states.length,
    witness: {
      entry: win.entry,
      prefix: win.prefix.map(edgeView),
      loop: win.loop.map(edgeView),
    },
    checkedPairs,
  };
}

function edgeView(e) {
  return {
    mode: e.mode,
    receipt: e.receipt,
    faultySide: {
      transId: e.fTrans?.id ?? null,
      from: e.fTrans ? e.fTrans.src : null,
      to: e.fTrans ? e.fTrans.dst : null,
      faulty: e.fTrans ? e.fTrans.faulty : false,
      silent: e.fTrans ? e.fTrans.silent : false,
    },
    normalSide: e.nTrans ? {
      transId: e.nTrans.id,
      from: e.nTrans.src,
      to: e.nTrans.dst,
      faulty: false,
      silent: e.nTrans.silent,
    } : null,
  };
}

// ===========================================================================
// 确诊延迟审计（K-diagnosability / twin-plant 有界歧义分析）
//
// 命题：系统已判可诊断（不存在无限伪装）。对每条“故障刚发生”的 verifier
// 边 e0（f 由 0 置 1，故障副本在该步走过 F 迁移），其终点种子对
// (p0, q0) 表示：故障已发生，此刻为止两侧可观察回执完全相同。
// 审计问题：从该种子出发，最多还能出现多少个与“始终正常执行”逐元素相同
// 的可观察回执，才必然出现可区分回执？
//   · 静默迁移（F_SILENT / N_SILENT）不产生回执，延迟 +0；
//   · 同回执同步（SYNC）延迟 +1；
// 只计两侧都能延续为【无限执行】的对：
//   种子两侧位置必须都是“活位置”（在各自允许的迁移图中能到达某个环，
//   即存在从该位置出发的无限路径）；分析路径只许经过两侧皆活的 verifier
//   状态。有限死路（某侧无无限延续）自然终止匹配，绝不用来凑上界。
// 不做有限回放、不比较位置名称：活位置由迭代核（环可达核）精确计算。
//
// 结果：
//   finite=false  种子可在“双侧皆活”子图中沿含 SYNC 的环无限同步
//                 （即无限伪装，正常情况下 diagnose 会判不可诊断；
//                 复用既有不可诊断结论，不给有限数字）；
//   finite=true   delay 为精确最大延迟（SYNC 计数），并给出
//                 达到该延迟的稳定裁决路径与下一可区分回执。
// ===========================================================================

// 活位置核对：给定允许迁移集合，位置活 ⇔ 它能到达某个环。
// 迭代核（反复删“出度为 0”的汇点）：删除汇点后其前驱出度递减，最终存留者为活。
function liveCore(succ) {
  const outdeg = new Map();
  const pred = new Map();
  for (const [u, outs] of succ) {
    if (!outdeg.has(u)) outdeg.set(u, 0);
    if (!pred.has(u)) pred.set(u, []);
  }
  for (const [u, outs] of succ) {
    outdeg.set(u, outs.length);
    for (const w of outs) {
      if (!pred.has(w)) pred.set(w, []);
      if (!outdeg.has(w)) outdeg.set(w, 0);
      pred.get(w).push(u);
    }
  }
  const dead = [];
  for (const [u] of succ) if (outdeg.get(u) === 0) dead.push(u);
  const removed = new Set();
  for (let h = 0; h < dead.length; h++) {
    const u = dead[h];
    if (removed.has(u)) continue;
    removed.add(u);
    for (const p of pred.get(u) ?? []) {
      if (removed.has(p)) continue;
      outdeg.set(p, outdeg.get(p) - 1);
      if (outdeg.get(p) === 0) dead.push(p);
    }
  }
  return removed;
}

function modelSucc(model, { normalOnly = false } = {}) {
  const succ = new Map();
  for (const loc of model.locations) succ.set(loc, []);
  for (const t of model.transitions) {
    if (normalOnly && t.faulty) continue;
    succ.get(t.src).push(t.dst);
  }
  return succ;
}

// 延迟审计。返回 { finite, delay?, witness?, seedsConsidered, ... }
export function delayAudit(model, diagnosis = null) {
  const v = buildVerifier(model);

  // 活位置：故障副本用完整自动机；正常副本删除全部 F 迁移（后继为位置名）
  const deadFull = liveCore(modelSucc(model));
  const deadNormal = liveCore(modelSucc(model, { normalOnly: true }));
  const liveF = (loc) => !deadFull.has(loc);
  const liveN = (loc) => !deadNormal.has(loc);

  // 既有诊断结论（调用方一般已算过；这里保持函数独立可用）
  const d = diagnosis ?? diagnose(model);

  // 枚举故障刚置位的边：from.f=0 且该边移动故障副本走过 F 迁移。
  // 每条这样的边唯一刻画一个“故障时刻 + 混淆前缀”的种子。
  const seeds = [];
  for (const s of v.states) {
    if (s.f !== 0) continue;
    for (const e of s.edges) {
      if (!(e.fTrans && e.fTrans.faulty)) continue; // 置位必由故障副本走 F
      if (e.to.f !== 1) continue;
      seeds.push({ via: e, from: s, state: e.to });
    }
  }

  // “双侧皆活”子图：仅保留两侧位置都能无限延续的 verifier 状态与边
  const good = new Set();
  for (const s of v.states) {
    if (liveF(s.p) && liveN(s.q)) good.add(s.id);
  }
  const subAdj = new Map();
  for (const s of v.states) {
    if (!good.has(s.id)) { subAdj.set(s, []); continue; }
    subAdj.set(s, s.edges.filter((e) => good.has(e.to.id)));
  };
  const adj = (s) => subAdj.get(s);

  // 子图 SCC：复用既有不可诊断判据 —— SCC 内同时存在移动故障副本与
  // 正常副本的边（mask=3 合格闭环）。含 SYNC 的环必然合格；全静默但
  // 两侧各有静默环时也合格（可观察序列恒空、仍永远不可区分，延迟无界）。
  // 仅单侧静默空转（对侧停滞）不算伪装，不判无界。
  const { compOf, comps } = tarjan(v.states, adj);
  const unboundedComps = new Set();
  for (const c of comps) {
    if (c.movesF && c.movesN) unboundedComps.add(c.id);
  }

  // 候选种子：种子状态须双侧皆活，且从初态可达（verifier 中皆可达，仍显式核验）
  const reach = reachable(v.start);
  const liveSeeds = seeds.filter((sd) => good.has(sd.state.id) && reach.has(sd.state));

  // 若任一活种子能在子图中到达无界同步环 ⇒ 存在无界伪装
  const canReachUnbounded = new Set();
  {
    // 反向子图传播
    const rev = new Map();
    for (const s of v.states) {
      for (const e of adj(s)) {
        if (!rev.has(e.to)) rev.set(e.to, []);
        rev.get(e.to).push(s);
      }
    }
    const q = [];
    for (const s of v.states) {
      if (unboundedComps.has(compOf.get(s))) { canReachUnbounded.add(s); q.push(s); }
    }
    for (let h = 0; h < q.length; h++) {
      for (const p of rev.get(q[h]) ?? []) {
        if (!canReachUnbounded.has(p)) { canReachUnbounded.add(p); q.push(p); }
      }
    }
  }

  const unboundedSeed = liveSeeds.find((sd) => canReachUnbounded.has(sd.state));
  if (unboundedSeed) {
    return {
      finite: false,
      diagnosable: false,
      seedCount: liveSeeds.length,
      deadEndSeedCount: seeds.length - liveSeeds.length,
      message: '存在可在双侧皆活子图中无限同回执同步的故障对：无界伪装，复用不可诊断结论',
    };
  }

  // 有限情形：没有任何活种子能到达“双侧移动环”分量。
  // R = 从活种子在“双侧皆活”子图中可达的状态集。R 内每个 SCC 都不是
  // 双侧移动环（否则从某活种子可达，上面已判无界）。R 的 SCC 内部边因此
  // 只可能是单侧静默（SYNC 内边必同时移动两侧，已属无界），权恒为 0，
  // 故分量级 DAG 最长路对 SYNC 计数是精确的。
  const R = new Set();
  {
    const q = liveSeeds.map((sd) => sd.state);
    for (const s of q) R.add(s);
    for (let h = 0; h < q.length; h++) {
      for (const e of adj(q[h])) if (!R.has(e.to)) { R.add(e.to); q.push(e.to); }
    }
  }
  const rStates = v.states.filter((s) => R.has(s));
  const rAdj = (s) => adj(s).filter((e) => R.has(e.to));
  const { compOf: rcOf, comps: rComps } = tarjan(rStates, rAdj);

  if (liveSeeds.length > 0) {
    // 防御性不变量：R 内不得有“双侧移动”SCC（那本应是无界）
    for (const c of rComps) {
      if (c.movesF && c.movesN) {
        return {
          finite: false,
          diagnosable: false,
          seedCount: liveSeeds.length,
          deadEndSeedCount: seeds.length - liveSeeds.length,
          message: '双侧皆活子图中出现双侧移动环：无界伪装，复用不可诊断结论',
        };
      }
    }
  }

  // 分量跨边（具体边，保留源状态与边键供稳定重建）
  const compOut = new Map();
  for (const c of rComps) compOut.set(c.id, []);
  for (const c of rComps) {
    for (const m of c.members) {
      for (const e of rAdj(m)) {
        const dc = rcOf.get(e.to);
        if (dc === c.id) continue;
        compOut.get(c.id).push({
          e, from: m, dc,
          w: e.mode === 'SYNC' ? 1 : 0,
          key: edgeKey(e),
        });
      }
    }
  }

  // DAG 拓扑（分量图必无环）
  const indegC = new Map(rComps.map((c) => [c.id, 0]));
  for (const list of compOut.values()) {
    for (const x of list) indegC.set(x.dc, indegC.get(x.dc) + 1);
  }
  const topo = [];
  {
    const q = rComps.filter((c) => indegC.get(c.id) === 0).map((c) => c.id);
    for (let h = 0; h < q.length; h++) {
      topo.push(q[h]);
      for (const x of compOut.get(q[h])) {
        indegC.set(x.dc, indegC.get(x.dc) - 1);
        if (indegC.get(x.dc) === 0) q.push(x.dc);
      }
    }
  }

  // dist[c]：从分量 c 内任一点出发，沿子图还能出现的最大 SYNC 回执数。
  // best[c]：达到 dist 的稳定出口边（计数降序，平局边键升序）。
  const dist = new Map();
  const best = new Map();
  for (let i = topo.length - 1; i >= 0; i--) {
    const cid = topo[i];
    let bd = 0, bx = null;
    for (const x of compOut.get(cid)) {
      const cand = x.w + dist.get(x.dc);
      if (cand > bd || (cand === bd && cand > 0 && (bx === null || x.key < bx.key))) {
        bd = cand;
        bx = x;
      }
    }
    dist.set(cid, bd);
    best.set(cid, bx);
  }

  // 分量内部最短（步数最少，平局路径标识键最小）路径：强连通保证可达。
  // 内部边权全 0，不影响延迟，只用于逐步对应展示。
  const memberSet = (cid) => new Set(rComps[cid].members.map((m) => m.id));
  function shortestIntra(cid, start, goal) {
    if (start === goal) return [];
    const members = memberSet(cid);
    const out0 = (s) => rAdj(s).filter((e) => members.has(e.to.id));
    const level = new Map([[start.id, 0]]);
    const parent = new Map(); // node.id -> { fromId, edge }
    let frontier = [start];
    for (let d = 1; frontier.length; d++) {
      const next = [];
      for (const s of frontier) {
        for (const e of out0(s)) {
          if (!level.has(e.to)) {
            level.set(e.to, d);
            parent.set(e.to.id, { fromId: s.id, edge: e });
            next.push(e.to);
          } else if (level.get(e.to) === d) {
            // 同层：按到达路径键取小（逐步比较父链 + 本条边键）
            const cur = parent.get(e.to.id);
            const candKey = edgeKey(e);
            if (cur && candKey < edgeKey(cur.edge)) {
              parent.set(e.to.id, { fromId: s.id, edge: e });
            }
          }
        }
      }
      frontier = next;
    }
    if (!level.has(goal.id)) return null;
    const edges = [];
    let curId = goal.id;
    while (curId !== start.id) {
      const p = parent.get(curId);
      if (!p) return null;
      edges.push(p.edge);
      curId = p.fromId;
    }
    return edges.reverse();
  }

  // 从种子状态重建达到最大 SYNC 计数的逐步路径
  function rebuildDelayPath(seedState) {
    const out = [];
    let cur = seedState;
    for (let guard = 0; guard < v.states.length + 1; guard++) {
      const cid = rcOf.get(cur);
      if (dist.get(cid) === 0) break;
      const bx = best.get(cid);
      if (!bx) break;
      const intra = shortestIntra(cid, cur, bx.from);
      if (intra === null) break;
      out.push(...intra, bx.e);
      cur = bx.e.to;
    }
    return { edges: out, end: cur };
  }

  // 到各状态的最短前缀（静默权 0、同步权 1，平局标识键最小）
  const allBest = dijkstraAll(v.start);
  const fOut = new Map();
  const nOut = new Map();
  for (const loc of model.locations) { fOut.set(loc, []); nOut.set(loc, []); }
  for (const t of model.transitions) {
    fOut.get(t.src).push(t);
    if (!t.faulty) nOut.get(t.src).push(t);
  }

  // 终点处的“下一可区分回执”：在双侧皆活子图的静默闭包内，收集两侧
  // 各自【发出后仍能无限延续】（目标仍为活位置）的下一可观察回执。
  // 两个集合必不相交：否则存在一条双侧皆活的 SYNC 延续，与 dist=0（最长）矛盾。
  function nextDistinguishing(end) {
    const reached = new Set([end]);
    const q = [end];
    for (let h = 0; h < q.length; h++) {
      const s = q[h];
      for (const e of rAdj(s)) {
        if (e.mode !== 'SYNC' && !reached.has(e.to)) { reached.add(e.to); q.push(e.to); }
      }
    }
    const fRecv = new Map();
    const nRecv = new Map();
    for (const s of reached) {
      for (const t of fOut.get(s.p) ?? []) {
        // 只计发出后故障侧仍能无限延续的候选（目标活），死路回执不冒充区分
        if (!t.silent && liveF(t.dst) && !fRecv.has(t.receipt)) fRecv.set(t.receipt, t);
      }
      for (const t of nOut.get(s.q) ?? []) {
        if (!t.silent && liveN(t.dst) && !nRecv.has(t.receipt)) nRecv.set(t.receipt, t);
      }
    }
    const sample = (t) => t ? {
      transId: t.id, from: t.src, to: t.dst,
      faulty: t.faulty, silent: false, receipt: t.receipt,
    } : null;
    return {
      faultyReceipts: [...fRecv.keys()].sort(),
      normalReceipts: [...nRecv.keys()].sort(),
      faultySample: sample([...fRecv.values()].sort((a, b) => a.id.localeCompare(b.id))[0]),
      normalSample: sample([...nRecv.values()].sort((a, b) => a.id.localeCompare(b.id))[0]),
      silentClosureSize: reached.size,
    };
  }

  const candidates = [];
  for (const sd of liveSeeds) {
    const cid = rcOf.get(sd.state);
    const postSync = dist.get(cid) ?? 0;
    // 延迟只计故障【发生后】的相同回执：置位步自身的回执（可观察故障）
    // 属于“抵达故障的共同前缀”，不计入延迟。
    const delay = postSync;
    const viaReceipt = sd.via.mode === 'SYNC' ? 1 : 0;
    const preEdges = shortestPath(allBest, v.start, sd.from) ?? [];
    const prefix = [...preEdges, sd.via];
    const built = rebuildDelayPath(sd.state);
    candidates.push({
      delay,
      preReceiptLength: recvCount(preEdges),
      viaReceipt,
      postSync,
      seed: sd,
      prefix,
      delayPath: built.edges,
      end: built.end,
      sortKey: `${pathKey(prefix)}#${pathKey(built.edges)}`,
    });
  }

  // 稳定裁决：延迟值降序 → 故障前共同回执长度升序 → 两侧迁移标识拼接升序。
  // 同一故障对状态可能因双侧静默步的不同交织出现多个种子（可观察行为等价），
  // 按种子状态去重，保留裁决键最小者。
  const bySeedState = new Map();
  for (const c of candidates) {
    const k = c.seed.state.id;
    const prev = bySeedState.get(k);
    if (!prev ||
        c.delay > prev.delay ||
        (c.delay === prev.delay && c.preReceiptLength < prev.preReceiptLength) ||
        (c.delay === prev.delay && c.preReceiptLength === prev.preReceiptLength &&
          c.sortKey < prev.sortKey)) {
      bySeedState.set(k, c);
    }
  }
  const uniqueCandidates = [...bySeedState.values()];
  uniqueCandidates.sort((a, b) =>
    (b.delay - a.delay) ||
    (a.preReceiptLength - b.preReceiptLength) ||
    a.sortKey.localeCompare(b.sortKey));

  if (uniqueCandidates.length === 0) {
    return {
      finite: true,
      diagnosable: true,
      delay: 0,
      seedCount: 0,
      deadEndSeedCount: seeds.length,
      message: '没有任何故障对的两侧都能延续为无限执行：有限死路不计入上界，延迟上界为 0',
      winner: null,
    };
  }

  const win = uniqueCandidates[0];
  const postSyncCheck = recvCount(win.delayPath);
  return {
    finite: true,
    diagnosable: true,
    delay: win.delay,
    seedCount: liveSeeds.length,
    deadEndSeedCount: seeds.length - liveSeeds.length,
    candidateCount: uniqueCandidates.length,
    message: `有限确诊延迟上界 ${win.delay}：故障发生后至多再出现 ${win.delay} 个相同可观察回执`,
    winner: {
      delay: win.delay,
      preFaultReceiptLength: win.preReceiptLength,
      viaReceiptIncluded: win.viaReceipt === 1,
      postFaultSync: win.postSync,
      postSyncCheck,
      seedPair: { p: win.seed.state.p, q: win.seed.state.q },
      faultTrans: {
        transId: win.seed.via.fTrans.id,
        from: win.seed.via.fTrans.src,
        to: win.seed.via.fTrans.dst,
        faulty: true,
        silent: win.seed.via.fTrans.silent,
        receipt: win.seed.via.fTrans.receipt,
      },
      prefix: win.prefix.map(edgeView),
      delayPath: win.delayPath.map(edgeView),
      endPair: { p: win.end.p, q: win.end.q },
      nextDistinguishing: nextDistinguishing(win.end),
    },
    allDelays: uniqueCandidates.map((c) => ({
      delay: c.delay,
      preFaultReceiptLength: c.preReceiptLength,
      seedPair: { p: c.seed.state.p, q: c.seed.state.q },
      faultTransId: c.seed.via.fTrans.id,
    })).sort((a, b) =>
      (b.delay - a.delay) || a.faultTransId.localeCompare(b.faultTransId)),
  };
}
