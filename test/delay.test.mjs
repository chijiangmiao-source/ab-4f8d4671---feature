// test/delay.test.mjs — 确诊延迟审计：有限上界 / 无界复用 / 死路不计入 / 稳定裁决
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpec } from '../src/parser.mjs';
import { analyze, analyzeDelay } from '../src/analyze.mjs';
import { computeDelay } from '../src/delay.mjs';
import { buildVerifier } from '../src/diagnoser.mjs';

function audit(text) {
  const m = parseSpec(text);
  assert.deepEqual(m.errors, [], `规程应无解析错误: ${JSON.stringify(m.errors)}`);
  return analyzeDelay(text);
}

// 带静默的有限上界：静默故障后还能同步两个 a（中间夹一步故障侧静默），
// 第三个回执 c 正常侧无法匹配 ⇒ 确诊延迟 2
const FINITE_SILENT = `
loc 0
loc 1
loc 2
loc 3
loc 4
loc 5
init 0
trans f1 0 1 F SILENT
trans g1 1 2 N a
trans g2 2 3 N SILENT
trans g3 3 4 N a
trans g4 4 4 N c
trans n1 0 5 N a
trans n2 5 5 N a
`;

test('带静默的有限上界：延迟 2，静默不计、同步计 1', () => {
  const r = audit(FINITE_SILENT);
  assert.equal(r.diagnosable, true);
  assert.equal(r.delay.value, 2);
  const w = r.delay.witness;
  // 故障静默 ⇒ 故障前共同回执长度 0
  assert.equal(w.preFaultReceipts, 0);
  assert.deepEqual(w.prefixObservable, []);
  // 前缀包含那条 F 静默迁移
  assert.ok(w.prefix.some(
    (s) => s.faultySide.transId === 'f1' && s.faultySide.faulty && s.faultySide.silent));
  // 延迟段：SYNC a · 故障侧静默 · SYNC a
  assert.deepEqual(w.tail.map((s) => s.mode), ['SYNC', 'F_SILENT', 'SYNC']);
  assert.deepEqual(w.tailObservable, ['a', 'a']);
  assert.equal(w.entry.p, '1');
  assert.equal(w.entry.q, '0');
  assert.deepEqual(w.end, { p: '4', q: '5' });
  // 下一可区分回执 c（故障侧 g4 可产生且保持无限延续）
  assert.equal(w.nextDistinguishing.receipt, 'c');
  assert.equal(w.nextDistinguishing.transId, 'g4');
  assert.equal(w.sequencesIdentical, true);
});

// 无界伪装：复用不可诊断结论，不给出有限数字
const SILENT_DOUBLE_LOOP = `
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

test('无界伪装：复用不可诊断结论，不给有限延迟', () => {
  const r = audit(SILENT_DOUBLE_LOOP);
  assert.equal(r.diagnosable, false);
  assert.equal(r.delayUnbounded, true);
  assert.equal(r.delay, undefined, '不得给出有限延迟数字');
  assert.ok(r.witness?.loop?.length >= 1, '保留原不可诊断证据');
  assert.equal(r.witness.sequencesIdentical, true);
});

// 死路不计入上界：b 分支三步同步后双侧走进死路（不得计入）；
// 只有 a 分支两侧都能无限延续 ⇒ 确诊延迟 1 而非 3
const DEAD_END_NOT_COUNTED = `
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
trans ga 1 2 N a
trans gc 2 2 N c
trans gb1 1 3 N b
trans gb2 3 4 N b
trans gb3 4 5 N b
trans na 0 6 N a
trans na2 6 6 N a
trans nb1 0 7 N b
trans nb2 7 8 N b
trans nb3 8 9 N b
`;

test('死路不计入上界：有限死路分支的 3 步同步被排除 ⇒ 延迟 1', () => {
  const r = audit(DEAD_END_NOT_COUNTED);
  assert.equal(r.diagnosable, true);
  assert.equal(r.delay.value, 1);
  const w = r.delay.witness;
  assert.deepEqual(w.tail.map((s) => [s.faultySide.transId, s.normalSide.transId]),
    [['ga', 'na']]);
  assert.equal(w.nextDistinguishing.receipt, 'c');
});

test('故障侧只能走进死路 ⇒ 延迟 0 且无证据对', () => {
  const r = audit(`
loc 0
loc 1
loc 2
loc 3
init 0
trans f1 0 1 F SILENT
trans g1 1 2 N a
trans n1 0 3 N a
trans n2 3 3 N a
`);
  assert.equal(r.diagnosable, true);
  assert.equal(r.delay.value, 0);
  assert.equal(r.delay.witness, null);
  assert.equal(r.delay.viablePairs, 0);
});

test('可观察故障后立即可区分 ⇒ 延迟 0（EX_DIAG 回归）', () => {
  const r = audit(`
loc 0
loc 1
loc 2
init 0
trans f1 0 1 F a
trans t1 1 1 N b
trans n1 0 2 N a
`);
  assert.equal(r.diagnosable, true);
  assert.equal(r.delay.value, 0);
  assert.equal(r.delay.witness, null);
});

test('正常侧静默迁移参与延迟段（N_SILENT 不计入）', () => {
  const r = audit(`
loc 0
loc 1
loc 2
loc 3
loc 4
init 0
trans f1 0 1 F SILENT
trans g1 1 2 N a
trans g2 2 2 N c
trans ne 0 3 N SILENT
trans n1 3 4 N a
trans n2 4 4 N a
`);
  assert.equal(r.diagnosable, true);
  assert.equal(r.delay.value, 1);
  const modes = r.delay.witness.tail.map((s) => s.mode);
  assert.deepEqual(modes, ['N_SILENT', 'SYNC']);
  assert.equal(r.delay.witness.nextDistinguishing.receipt, 'c');
});

test('故障前共同回执不计入延迟：前缀 x 与故障回执 a 都不算 ⇒ 延迟 0', () => {
  const r = audit(`
loc 0
loc 1
loc 2
loc 3
init 0
trans s0 0 1 N x
trans f1 1 2 F a
trans g1 2 2 N b
trans n1 1 3 N a
trans n2 3 3 N a
`);
  assert.equal(r.diagnosable, true);
  assert.equal(r.delay.value, 0);
  const w = r.delay.witness;
  assert.ok(w, '有入口证据但延迟为 0');
  assert.equal(w.preFaultReceipts, 1, '故障前共同回执为 x');
  assert.deepEqual(w.prefixObservable, ['x', 'a']);
  assert.deepEqual(w.tailObservable, []);
  assert.equal(w.nextDistinguishing.receipt, 'b');
});

test('稳定裁决：同一规程两次审计给出相同延迟证据', () => {
  const a = audit(FINITE_SILENT);
  const b = audit(FINITE_SILENT);
  assert.equal(JSON.stringify(a.delay), JSON.stringify(b.delay));
});

test('证据真实性：前缀+延迟段在 verifier 上逐步可走，终点与同步数吻合', () => {
  const m = parseSpec(FINITE_SILENT);
  const v = buildVerifier(m);
  const r = analyzeDelay(FINITE_SILENT);
  const w = r.delay.witness;
  let cur = v.start;
  const step = (s) => {
    const e = cur.edges.find((x) =>
      (x.fTrans?.id ?? null) === s.faultySide.transId &&
      (x.nTrans?.id ?? null) === (s.normalSide?.transId ?? null) &&
      x.mode === s.mode);
    assert.ok(e, '每一步都应是真实 verifier 边');
    cur = e.to;
  };
  for (const s of w.prefix) step(s);
  assert.equal(cur.f, 1, '前缀结束于故障之后');
  assert.equal(cur.p, w.entry.p);
  assert.equal(cur.q, w.entry.q);
  for (const s of w.tail) step(s);
  assert.equal(cur.p, w.end.p);
  assert.equal(cur.q, w.end.q);
  const syncs = w.tail.filter((s) => s.mode === 'SYNC').length;
  assert.equal(syncs, r.delay.value, '延迟段同步回执数等于延迟值');
});

test('原有判定接口回归：analyze 不附带延迟结论，证据形状不变', () => {
  const r1 = analyze(FINITE_SILENT);
  assert.equal(r1.diagnosable, true);
  assert.equal(r1.delay, undefined);
  assert.ok(Array.isArray(r1.checkedPairs));

  const r2 = analyze(SILENT_DOUBLE_LOOP);
  assert.equal(r2.diagnosable, false);
  assert.equal(r2.delay, undefined);
  assert.equal(r2.witness.prefixReceiptLength, 0);
  assert.ok(r2.witness.loopReceiptLength >= 1);
});

test('computeDelay 守卫：无界伪装返回 unbounded', () => {
  const m = parseSpec(SILENT_DOUBLE_LOOP);
  const d = computeDelay(m);
  assert.equal(d.unbounded, true);
});
