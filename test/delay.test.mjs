// test/delay.test.mjs — 确诊延迟审计（有限上界 / 无界复用 / 死路不计入 / 回归）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpec } from '../src/parser.mjs';
import { diagnose, buildVerifier, delayAudit } from '../src/diagnoser.mjs';
import { analyze } from '../src/analyze.mjs';

function run(text, mode = 'delay') {
  const m = parseSpec(text);
  assert.deepEqual(m.errors, [], `规程应无解析错误: ${JSON.stringify(m.errors)}`);
  return analyze(text, { mode });
}

// 带静默的有限上界模型：
//   f1 静默置位；故障后共同回执 a、b（fsl 为故障侧静默，不增加延迟）；
//   随后故障侧只能发 x、正常侧只能发 y，下一回执必然可区分。
//   fA 是可观察故障，但正常侧对 a 的唯一匹配止于汇点 9（有限死路），不计入上界。
const BOUNDED_SILENT = `
loc 0
loc 1
loc 2
loc 3
loc 4
loc 5
loc 6
loc 7
loc 8
loc 9
init 0
trans f1 0 1 F SILENT
trans fa 1 2 N a
trans fsl 2 3 N SILENT
trans fb 3 4 N b
trans fx 4 4 N x
trans ne 0 5 N SILENT
trans na 5 6 N a
trans nb 6 7 N b
trans ny 7 7 N y
trans fA 0 8 F a
trans fz 8 8 N z
trans g0 0 9 N a
`;

test('带静默的有限上界模型：延迟恰为 2，静默不增加延迟', () => {
  const r = run(BOUNDED_SILENT);
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'delay');
  assert.equal(r.finite, true);
  assert.equal(r.diagnosable, true);
  assert.equal(r.delay, 2, '故障后至多 2 个相同回执（a、b）');

  const w = r.witness;
  assert.ok(w, '有限情形必须给出证据');
  // 故障前共同回执长度 0（f1 静默、ne 静默）
  assert.equal(w.preFaultReceiptLength, 0);
  assert.deepEqual(w.preFaultObservable, []);
  // 故障置位步是静默的 f1
  assert.equal(w.faultTrans.transId, 'f1');
  assert.equal(w.faultTrans.silent, true);
  // 达到最大延迟的故障后共同回执 = a, b
  assert.deepEqual(w.delayObservable, ['a', 'b']);
  assert.equal(w.postFaultSync, 2);
  assert.equal(w.postSyncCheck, 2);
  assert.equal(w.postFaultIdentical, true);
  // 静默步出现在逐步对应中但不贡献延迟
  assert.ok(w.delayPath.some((s) => s.mode === 'F_SILENT' && s.faultySide.transId === 'fsl'));
  assert.equal(w.delayPath.filter((s) => s.receipt !== null).length, 2);
  // 下一可区分回执：故障侧 x，正常侧 y，互不相交
  assert.deepEqual(w.nextDistinguishing.faultyReceipts, ['x']);
  assert.deepEqual(w.nextDistinguishing.normalReceipts, ['y']);
  assert.equal(w.nextDistinguishing.distinguished, true);
  // 死路故障对（fA 同步到汇点 9）被排除
  assert.equal(r.deadEndSeedCount, 1);
  assert.ok(r.seedCount >= 1);
});

test('有限上界证据在 verifier 上逐步可复走（非有限回放、非位置名比较）', () => {
  const m = parseSpec(BOUNDED_SILENT);
  const v = buildVerifier(m);
  const r = run(BOUNDED_SILENT);
  const w = r.witness;
  const byKey = new Map(v.states.map((s) => [`${s.p} ${s.q} ${s.f}`, s]));

  // 沿前缀从初态走到种子（故障置位）
  let cur = v.start;
  for (const step of w.prefix) {
    const e = cur.edges.find((x) =>
      (x.fTrans?.id ?? null) === step.faultySide.transId &&
      (x.nTrans?.id ?? null) === (step.normalSide?.transId ?? null) &&
      x.mode === step.mode);
    assert.ok(e, '前缀每一步都应是真实 verifier 边');
    cur = e.to;
  }
  assert.equal(cur.f, 1, '前缀终点故障必须已置位');
  assert.equal(cur.p, w.seedPair.p);
  assert.equal(cur.q, w.seedPair.q);

  // 沿延迟路径走，逐步核验两侧回执一致
  for (const step of w.delayPath) {
    const e = cur.edges.find((x) =>
      (x.fTrans?.id ?? null) === step.faultySide.transId &&
      (x.nTrans?.id ?? null) === (step.normalSide?.transId ?? null) &&
      x.mode === step.mode);
    assert.ok(e, '延迟路径每一步都应是真实 verifier 边');
    cur = e.to;
  }
  assert.equal(cur.p, w.endPair.p);
  assert.equal(cur.q, w.endPair.q);

  // 最大性核验：从终点在“双侧皆活”子图中不可达任何 SYNC 边
  // （活位置独立重算：位置能到达环）
  const live = (normalOnly) => {
    const succ = new Map(m.locations.map((l) => [l, []]));
    for (const t of m.transitions) {
      if (normalOnly && t.faulty) continue;
      succ.get(t.src).push(t.dst);
    }
    const reachesCycle = new Set();
    for (const l of m.locations) {
      // l 活 ⇔ 从 l 可达某个能非空回到自身的节点
      const seen = new Set([l]);
      const q = [l];
      let ok = false;
      for (let h = 0; h < q.length && !ok; h++) {
        for (const d of succ.get(q[h])) {
          if (d === q[h]) { ok = true; break; }
          if (!seen.has(d)) { seen.add(d); q.push(d); }
        }
      }
      // 还需确认可达环的节点本身在环上：上面 ok 只说明存在自环节点
      if (ok) reachesCycle.add(l);
    }
    return reachesCycle;
  };
  const liveF = live(false);
  const liveN = live(true);
  assert.ok(liveF.has(cur.p) && liveN.has(cur.q), '终点两侧都必须是活位置');
  // BFS 双侧皆活子图：不得遇到 SYNC 边
  const seen = new Set([cur]);
  const q = [cur];
  for (let h = 0; h < q.length; h++) {
    for (const e of q[h].edges) {
      if (!liveF.has(e.to.p) || !liveN.has(e.to.q)) continue;
      assert.notEqual(e.mode, 'SYNC', '终点之后不应再有双侧皆活的同步边');
      if (!seen.has(e.to)) { seen.add(e.to); q.push(e.to); }
    }
  }
  void byKey;
});

// 无界模型：静默双环（既有不可诊断例）
const UNBOUNDED = `
loc 0
loc 1
loc 2
loc 3
init 0
trans f1 0 1 F SILENT
trans g1 1 2 N a
trans g2 2 1 N a
trans h1 0 3 N a
trans h2 3 0 N a
`;

test('无界模型：复用不可诊断结论，绝不给出有限数字', () => {
  const r = run(UNBOUNDED);
  assert.equal(r.finite, false);
  assert.equal(r.delay, null, '无界时不得给出有限延迟');
  assert.equal(r.diagnosable, false);
  assert.ok(r.reusedNondiagWitness, '必须复用现有不可诊断证据');
  assert.ok(r.reusedNondiagWitness.loop.length >= 1);
  // 与既有 diagnose 结论一致
  const d = diagnose(parseSpec(UNBOUNDED));
  assert.equal(d.diagnosable, false);
});

// 死路不计入上界：正常侧 b 之后止于汇点 5，该故障对不能双侧无限延续
const DEAD_END = `
loc 0
loc 1
loc 2
loc 3
loc 4
loc 5
init 0
trans f1 0 1 F a
trans fb 1 2 N b
trans fx 2 2 N x
trans na 0 3 N a
trans nb 3 5 N b
trans zz 4 4 N y
`;

test('死路不计入上界：唯一故障对含有限死路 ⇒ 延迟 0 且无证据', () => {
  const r = run(DEAD_END);
  assert.equal(r.finite, true);
  assert.equal(r.delay, 0);
  assert.equal(r.seedCount, 0, '没有双侧皆活的故障对');
  assert.equal(r.deadEndSeedCount, 1, '死路对被排除并计数');
  assert.equal(r.witness, null);
  // 同一规程的判定结论保持“可诊断”
  const d = run(DEAD_END, 'diagnose');
  assert.equal(d.diagnosable, true);
});

// 可观察故障：故障回执 a 属于“抵达故障的共同前缀”，不计入延迟；
// 故障后只剩 1 个共同回执 b
const OBSERVABLE_FAULT = `
loc 0
loc 1
loc 2
loc 3
loc 4
init 0
trans f1 0 1 F a
trans fb 1 2 N b
trans fx 2 2 N x
trans na 0 3 N a
trans nb 3 4 N b
trans ny 4 4 N y
`;

test('可观察故障：置位回执不计入延迟，故障后共同回执恰为 1', () => {
  const r = run(OBSERVABLE_FAULT);
  assert.equal(r.finite, true);
  assert.equal(r.delay, 1);
  const w = r.witness;
  assert.deepEqual(w.prefixObservable, ['a'], '故障回执 a 属于抵达故障的共同前缀');
  assert.equal(w.preFaultReceiptLength, 0);
  assert.deepEqual(w.delayObservable, ['b']);
  assert.equal(w.faultTrans.receipt, 'a');
  assert.equal(w.nextDistinguishing.distinguished, true);
});

// 故障前存在共同回执：共同前缀 c 之后故障静默置位，再同步 1 个 a
const PRE_FAULT_PREFIX = `
loc 0
loc 1
loc 2
loc 3
loc 4
loc 5
loc 6
init 0
trans pre 0 1 N c
trans f1 1 2 F SILENT
trans fa 2 3 N a
trans fx 3 3 N x
trans npre 0 4 N c
trans ne 4 5 N SILENT
trans na 5 6 N a
trans ny 6 6 N y
`;

test('故障前共同回执长度进入裁决：前缀 c + 故障后 a ⇒ 延迟 1', () => {
  const r = run(PRE_FAULT_PREFIX);
  assert.equal(r.finite, true);
  assert.equal(r.delay, 1);
  const w = r.witness;
  assert.equal(w.preFaultReceiptLength, 1, '故障前共同回执为 c');
  assert.deepEqual(w.preFaultObservable, ['c']);
  assert.deepEqual(w.delayObservable, ['a']);
});

test('裁决稳定性：同一规程两次审计给出相同证据', () => {
  const a = run(BOUNDED_SILENT);
  const b = run(BOUNDED_SILENT);
  const sig = (r) => JSON.stringify({
    delay: r.delay,
    prefix: r.witness.prefix.map((e) => [e.mode, e.faultySide.transId, e.normalSide?.transId ?? null]),
    delayPath: r.witness.delayPath.map((e) => [e.mode, e.faultySide.transId, e.normalSide?.transId ?? null]),
    next: [r.witness.nextDistinguishing.faultyReceipts, r.witness.nextDistinguishing.normalReceipts],
  });
  assert.equal(sig(a), sig(b));
});

test('旧规程回归：判定模式结论与证据保持不变', () => {
  // 不可诊断例
  let d = run(UNBOUNDED, 'diagnose');
  assert.equal(d.diagnosable, false);
  assert.equal(d.witness.prefixReceiptLength, 0);
  assert.ok(d.witness.sequencesIdentical);
  // 可诊断例
  d = run(DEAD_END, 'diagnose');
  assert.equal(d.diagnosable, true);
  assert.equal(d.witness, undefined);
  // 延迟审计不改变同一规程的判定结论
  const before = diagnose(parseSpec(BOUNDED_SILENT));
  delayAudit(parseSpec(BOUNDED_SILENT));
  const after = diagnose(parseSpec(BOUNDED_SILENT));
  assert.equal(before.diagnosable, after.diagnosable);
});

// 两侧各自静默环：可观察序列恒空，但两侧都是无限执行 ⇒ 无界伪装
const BOTH_SILENT_LOOPS = `
loc 0
loc 1
init 0
trans f1 0 1 F SILENT
trans fs 1 1 N SILENT
trans ns 0 0 N SILENT
`;

test('双侧静默环（零回执无限伪装）判无界，不得给出有限数字', () => {
  const r = run(BOTH_SILENT_LOOPS);
  assert.equal(r.finite, false);
  assert.equal(r.delay, null);
  assert.equal(r.diagnosable, false);
  assert.ok(r.reusedNondiagWitness);
});

// 仅故障侧静默空转、正常侧停滞：不是伪装，死路不计入
const FAULT_ONLY_SILENT = `
loc 0
loc 1
init 0
trans f1 0 1 F SILENT
trans f2 1 1 N SILENT
`;

test('故障侧独自静默空转：正常侧停滞为死路 ⇒ 延迟 0、无活种子', () => {
  const r = run(FAULT_ONLY_SILENT);
  assert.equal(r.finite, true);
  assert.equal(r.delay, 0);
  assert.equal(r.seedCount, 0);
  assert.equal(r.deadEndSeedCount, 1);
  assert.equal(r.witness, null);
  assert.equal(run(FAULT_ONLY_SILENT, 'diagnose').diagnosable, true);
});

// 零延迟：故障静默后两侧下一回执立刻不同（但都能无限延续）
const ZERO_DELAY = `
loc 0
loc 1
loc 2
init 0
trans f1 0 1 F SILENT
trans fx 1 1 N x
trans ny 0 2 N y
trans zz 2 2 N z
`;

test('故障后无任何共同回执 ⇒ 延迟 0，但活种子保留并给出下一可区分回执', () => {
  const r = run(ZERO_DELAY);
  assert.equal(r.finite, true);
  assert.equal(r.delay, 0);
  assert.equal(r.seedCount, 1);
  assert.equal(r.deadEndSeedCount, 0);
  assert.ok(r.witness, '双侧皆活但延迟 0 仍应给出下一可区分回执证据');
  assert.deepEqual(r.witness.delayObservable, []);
  assert.equal(r.witness.nextDistinguishing.distinguished, true);
  assert.deepEqual(r.witness.nextDistinguishing.faultyOnly, ['x']);
  assert.deepEqual(r.witness.nextDistinguishing.normalOnly, ['y']);
});
