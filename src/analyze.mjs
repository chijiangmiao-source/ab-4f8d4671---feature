// analyze.mjs — 解析 + 判定 + 视图模型（含确诊延迟审计）
import { parseSpec } from './parser.mjs';
import { diagnose } from './diagnoser.mjs';
import { computeDelay } from './delay.mjs';

function statsOf(model, result) {
  return {
    locations: model.locations.length,
    transitions: model.transitions.length,
    faultyTransitions: model.transitions.filter((t) => t.faulty).length,
    verifierStates: result.verifierStateCount,
  };
}

const obsOf = (steps) => steps.map((s) => s.receipt).filter((r) => r !== null);

// 校验两侧可观察序列逐元素相同（理论上构造保证，此处再断言式核验）
function sideObservables(steps) {
  const seqF = [];
  const seqN = [];
  for (const s of steps) {
    if (s.faultySide && !s.faultySide.silent && s.receipt !== null) seqF.push(s.receipt);
    if (s.normalSide && !s.normalSide.silent && s.receipt !== null) seqN.push(s.receipt);
  }
  return { seqF, seqN, identical: seqF.join(' ') === seqN.join(' ') };
}

function undiagnosableView(model, result) {
  const w = result.witness;
  const prefixObs = obsOf(w.prefix);
  const loopObs = obsOf(w.loop);
  const { seqF, seqN, identical } = sideObservables([...w.prefix, ...w.loop]);

  return {
    ok: true,
    diagnosable: false,
    stats: statsOf(model, result),
    witness: {
      entry: w.entry,
      prefix: w.prefix,
      loop: w.loop,
      prefixObservable: prefixObs,
      loopObservable: loopObs,
      prefixReceiptLength: prefixObs.length,
      loopReceiptLength: loopObs.length,
      faultySideObservable: seqF,
      normalSideObservable: seqN,
      sequencesIdentical: identical,
    },
    checkedPairs: result.checkedPairs,
  };
}

export function analyze(specText) {
  const model = parseSpec(specText);
  if (model.errors.length > 0 || model.init === null) {
    return { ok: false, errors: model.errors };
  }
  const result = diagnose(model);
  if (!result.diagnosable) return undiagnosableView(model, result);

  return {
    ok: true,
    diagnosable: true,
    stats: statsOf(model, result),
    checkedPairs: result.checkedPairs,
  };
}

// 确诊延迟审计：在可诊断结论上继续精确分析——故障发生后最多还能出现多少个
// 与始终正常执行相同的可观察回执；仍存在无界伪装时复用不可诊断结论，
// 不给出有限数字。
export function analyzeDelay(specText) {
  const model = parseSpec(specText);
  if (model.errors.length > 0 || model.init === null) {
    return { ok: false, errors: model.errors };
  }
  const result = diagnose(model);
  if (!result.diagnosable) {
    return { ...undiagnosableView(model, result), audit: 'delay', delayUnbounded: true };
  }
  const d = computeDelay(model);
  if (d.unbounded) { // 防御：diagnose 已排除无界伪装；仍复用不可诊断结论
    return { ...undiagnosableView(model, result), audit: 'delay', delayUnbounded: true };
  }

  const delay = { value: d.delay, viablePairs: d.viablePairs, witness: null };
  if (d.witness) {
    const w = d.witness;
    const { seqF, seqN, identical } = sideObservables([...w.prefix, ...w.tail]);
    delay.witness = {
      entry: w.entry,
      end: w.end,
      prefix: w.prefix,
      tail: w.tail,
      preFaultReceipts: w.preFaultReceipts,
      prefixObservable: obsOf(w.prefix),
      tailObservable: obsOf(w.tail),
      faultySideObservable: seqF,
      normalSideObservable: seqN,
      sequencesIdentical: identical,
      nextDistinguishing: w.nextDistinguishing,
    };
  }

  return {
    ok: true,
    diagnosable: true,
    audit: 'delay',
    stats: statsOf(model, result),
    checkedPairs: result.checkedPairs,
    delay,
  };
}
