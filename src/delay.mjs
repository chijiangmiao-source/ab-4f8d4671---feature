// delay.mjs — 确诊延迟审计：可诊断规程的故障后最大伪装回执数
//
// 在既有 verifier（diagnoser.buildVerifier）的可达故障对 (p,q,1) 上继续精确分析：
//   确诊延迟 = 故障发生后，仍能与一条从未故障的无限执行保持相同可观察回执的
//   最大回执个数。
//     · 静默迁移（F_SILENT / N_SILENT）不增加延迟；
//     · 同回执同步（SYNC）增加一个单位；
//     · 只计两侧都能延续为无限执行的对：故障侧位置在完整自动机、正常侧位置在
//       仅 N 自动机中各自存在无限延续（有限死路不计入上界）；
//     · 不做有限回放、不比较位置名称、不设定回放深度：可诊断时 SYNC 边在受限图上
//       不可能成环（否则即双侧可动闭环 ⇒ 不可诊断），故在 SCC 凝聚 DAG 上取精确最长路。
//
// 稳定裁决：延迟值最大者优先；并列按故障前共同回执长度最小；
// 再并列按两侧迁移标识拼接键字典序最小（与既有证据裁决同一约定）。
//
// 若受限图中仍存在双侧可动闭环（无界伪装），返回 { unbounded: true } ——
// 调用方复用不可诊断结论，不给出有限数字。

import {
  buildVerifier, tarjan, reachable, dijkstraAll, shortestPath,
  edgeView, edgeKey, edgeWeight, heap,
} from './diagnoser.mjs';

// 位置可无限延续 ⟺ 存在从它出发的无限迁移序列（有限图 ⟺ 能到达环）。
// 最大不动点：反复剔除在剩余集合中已无出边的位置。
function liveLocations(transitions, includeFaulty) {
  const outDeg = new Map();
  const pred = new Map();
  const ensure = (l) => {
    if (!outDeg.has(l)) { outDeg.set(l, 0); pred.set(l, []); }
  };
  for (const t of transitions) {
    if (!includeFaulty && t.faulty) continue;
    ensure(t.src); ensure(t.dst);
    outDeg.set(t.src, outDeg.get(t.src) + 1);
    pred.get(t.dst).push(t.src);
  }
  const live = new Set(outDeg.keys());
  const stack = [];
  for (const l of live) if (outDeg.get(l) === 0) stack.push(l);
  while (stack.length) {
    const l = stack.pop();
    live.delete(l);
    for (const p of pred.get(l)) {
      outDeg.set(p, outDeg.get(p) - 1);
      if (outDeg.get(p) === 0) stack.push(p);
    }
  }
  return live;
}

// 从 loc 出发、经若干静默迁移后能产生的第一批可观察回执（落点仍可无限延续）。
// 返回 Map：回执 -> { receipt, transId, from, to }（同回执取迁移标识最小者）。
function nextObservableReceipts(transitions, loc, live, includeFaulty) {
  const out = new Map();
  for (const t of transitions) {
    if (!includeFaulty && t.faulty) continue;
    if (!out.has(t.src)) out.set(t.src, []);
    out.get(t.src).push(t);
  }
  const seen = new Set([loc]);
  const queue = [loc];
  const found = new Map();
  for (let h = 0; h < queue.length; h++) {
    for (const t of out.get(queue[h]) ?? []) {
      if (t.silent) {
        if (!seen.has(t.dst)) { seen.add(t.dst); queue.push(t.dst); }
      } else if (live.has(t.dst)) {
        const cur = found.get(t.receipt);
        if (!cur || t.id < cur.transId) {
          found.set(t.receipt, { receipt: t.receipt, transId: t.id, from: t.src, to: t.dst });
        }
      }
    }
  }
  return found;
}

export function computeDelay(model) {
  const v = buildVerifier(model);
  const fromStart = reachable(v.start);
  const liveF = liveLocations(model.transitions, true);   // 故障侧：完整自动机
  const liveN = liveLocations(model.transitions, false);  // 正常侧：仅 N 自动机

  // 受限图：从初态可达、f=1、两侧位置都能无限延续的故障对
  const statesR = v.states.filter((s) =>
    s.f === 1 && fromStart.has(s) && liveF.has(s.p) && liveN.has(s.q));
  const nodeOf = new Map();
  const nodes = statesR.map((s, i) => {
    const n = { id: i, ref: s, edges: [] };
    nodeOf.set(s, n);
    return n;
  });
  for (const n of nodes) {
    for (const e of n.ref.edges) {
      const t = nodeOf.get(e.to);
      if (t) n.edges.push({ to: t, e, fTrans: e.fTrans, nTrans: e.nTrans });
    }
  }
  const { compOf, comps } = tarjan(nodes);

  // 无界伪装守卫：受限图内仍有双侧可动闭环 ⇒ 不可诊断，调用方复用原结论
  if (comps.some((c) => c.movesF && c.movesN)) return { unbounded: true };

  // 跨分量出边；Tarjan 按逆拓扑序产出分量（汇在前），按产出顺序 DP 时后继已就绪。
  // 分量内部边全为静默边（否则该分量即含 SYNC 环，上一步已拦截），权值为 0。
  const dC = comps.map(() => 0);
  comps.forEach((c, cid) => {
    let best = 0;
    for (const m of c.members) {
      for (const we of m.edges) {
        const cid2 = compOf.get(we.to);
        if (cid2 === cid) continue;
        const cand = edgeWeight(we.e) + dC[cid2];
        if (cand > best) best = cand;
      }
    }
    dC[cid] = best;
  });
  const delay = dC.reduce((m, x) => Math.max(m, x), 0);
  if (statesR.length === 0) {
    return { unbounded: false, delay: 0, viablePairs: 0, witness: null };
  }

  // 分量内部：从入口状态出发、只走分量内部（全为静默边）的最小键路径
  const compSilentPaths = (startNode, cid) => {
    const dist = new Map([[startNode, { key: '', edges: [] }]]);
    const h = heap();
    h.push([0, startNode, '']);
    while (h.size) {
      const [, node, key] = h.pop();
      const rec = dist.get(node);
      if (!rec || rec.key !== key) continue; // 过期堆条目
      for (const we of node.edges) {
        if (compOf.get(we.to) !== cid) continue;
        const nk = key + edgeKey(we.e) + ',';
        const known = dist.get(we.to);
        if (!known || nk < known.key) {
          dist.set(we.to, { key: nk, edges: [...rec.edges, we.e] });
          h.push([0, we.to, nk]);
        }
      }
    }
    return dist;
  };

  // 从状态 s 出发的最大延迟延续（值已由 dC 决定，此处取迁移标识键最小者）
  const contMemo = new Map();
  const bestContinuation = (s) => {
    if (contMemo.has(s.id)) return contMemo.get(s.id);
    const node = nodeOf.get(s);
    const cid = compOf.get(node);
    if (dC[cid] === 0) return { key: '', edges: [] };
    const dist = compSilentPaths(node, cid);
    let best = null;
    for (const [u, rec] of dist) {
      for (const we of u.edges) {
        const cid2 = compOf.get(we.to);
        if (cid2 === cid) continue;
        if (edgeWeight(we.e) + dC[cid2] !== dC[cid]) continue;
        const cont = bestContinuation(we.e.to);
        const key = rec.key + edgeKey(we.e) + ',' + cont.key;
        if (!best || key < best.key) {
          best = { key, edges: [...rec.edges, we.e, ...cont.edges] };
        }
      }
    }
    best = best ?? { key: '', edges: [] }; // 防御：dC>0 时必有达成边
    contMemo.set(s.id, best);
    return best;
  };

  // 候选入口：dC 达到最大、且紧接故障边（f=0 → f=1）的状态；
  // 前缀只走 f=0 区域加一条故障边，按（故障前共同回执长度, 迁移标识键）取最小
  const allBest = dijkstraAll(v.start);
  let choice = null;
  for (const a of v.states) {
    if (a.f !== 0) continue;
    const rec = allBest.get(a.id);
    if (!rec) continue;
    for (const e of a.edges) {
      if (!e.fTrans?.faulty) continue;
      const s = e.to;
      if (!nodeOf.has(s)) continue;
      if (dC[compOf.get(nodeOf.get(s))] !== delay) continue;
      const key = rec.pathKey + edgeKey(e) + ',';
      if (!choice || rec.cost < choice.preFault ||
          (rec.cost === choice.preFault && key < choice.key)) {
        choice = { s, a, e, preFault: rec.cost, key };
      }
    }
  }
  if (!choice) { // 理论上不可达（延迟最大者必可经故障边进入），防御兜底
    return { unbounded: false, delay, viablePairs: statesR.length, witness: null };
  }

  const prefixEdges = [...(shortestPath(allBest, v.start, choice.a) ?? []), choice.e];
  const tail = bestContinuation(choice.s).edges;
  let end = choice.s;
  for (const e of tail) end = e.to;

  // 下一可区分回执：故障侧还能产生（且保持无限延续）而正常侧无法匹配的回执
  const faultNext = nextObservableReceipts(model.transitions, end.p, liveF, true);
  const normalNext = nextObservableReceipts(model.transitions, end.q, liveN, false);
  const distinguishing = [...faultNext.values()]
    .filter((x) => !normalNext.has(x.receipt))
    .sort((x, y) => x.receipt < y.receipt ? -1 : x.receipt > y.receipt ? 1
      : x.transId < y.transId ? -1 : x.transId > y.transId ? 1 : 0);

  return {
    unbounded: false,
    delay,
    viablePairs: statesR.length,
    witness: {
      entry: { p: choice.s.p, q: choice.s.q },
      prefix: prefixEdges.map(edgeView),
      preFaultReceipts: choice.preFault,
      tail: tail.map(edgeView),
      end: { p: end.p, q: end.q },
      nextDistinguishing: distinguishing[0] ?? null,
    },
  };
}
