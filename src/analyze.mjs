// analyze.mjs — 解析 + 判定 + 视图模型
import { parseSpec } from './parser.mjs';
import { diagnose, delayAudit } from './diagnoser.mjs';

function statsOf(model, diagnosis) {
  return {
    locations: model.locations.length,
    transitions: model.transitions.length,
    faultyTransitions: model.transitions.filter((t) => t.faulty).length,
    verifierStates: diagnosis.verifierStateCount,
  };
}

// 确诊延迟审计视图模型
function delayView(model, diagnosis) {
  const a = delayAudit(model, diagnosis);

  // 无界伪装：复用现有不可诊断结论（diagnose 在此规程上本就会判不可诊断），
  // 绝不给出有限数字。
  if (!a.finite) {
    return {
      ok: true,
      mode: 'delay',
      finite: false,
      diagnosable: false,
      stats: statsOf(model, diagnosis),
      checkedPairs: diagnosis.checkedPairs,
      delay: null,
      message: a.message,
      seedCount: a.seedCount,
      deadEndSeedCount: a.deadEndSeedCount,
      // 复用现有不可诊断结论及其证据（不得给出有限数字）
      reusedNondiagWitness: diagnosis.witness,
    };
  }

  if (a.winner === null) {
    return {
      ok: true,
      mode: 'delay',
      finite: true,
      diagnosable: true,
      delay: 0,
      stats: statsOf(model, diagnosis),
      checkedPairs: diagnosis.checkedPairs,
      seedCount: 0,
      deadEndSeedCount: a.deadEndSeedCount,
      message: a.message,
      witness: null,
    };
  }

  const w = a.winner;

  // 到达故障的共同前缀（含故障置位步）与故障后的延迟路径
  const prefixObs = w.prefix.map((s) => s.receipt).filter((r) => r !== null);
  const delayObs = w.delayPath.map((s) => s.receipt).filter((r) => r !== null);
  // 故障前的共同回执（不含置位步）
  const preFaultObs = w.prefix
    .slice(0, w.prefix.length - 1)
    .map((s) => s.receipt)
    .filter((r) => r !== null);

  // 断言式核验：延迟路径恰好贡献 delay 个回执，且两侧逐元素相同
  const seqF = [], seqN = [];
  for (const s of w.delayPath) {
    if (s.faultySide && !s.faultySide.silent && s.receipt !== null) seqF.push(s.receipt);
    if (s.normalSide && !s.normalSide.silent && s.receipt !== null) seqN.push(s.receipt);
  }
  const postIdentical = seqF.join('') === seqN.join('') && seqF.length === w.delay;

  // 下一可区分回执：两侧候选集合必须不相交
  const nd = w.nextDistinguishing;
  const fOnly = nd.faultyReceipts.filter((r) => !nd.normalReceipts.includes(r));
  const nOnly = nd.normalReceipts.filter((r) => !nd.faultyReceipts.includes(r));
  const distinguished = fOnly.length > 0 || nOnly.length > 0;

  return {
    ok: true,
    mode: 'delay',
    finite: true,
    diagnosable: true,
    delay: a.delay,
    stats: statsOf(model, diagnosis),
    checkedPairs: diagnosis.checkedPairs,
    seedCount: a.seedCount,
    deadEndSeedCount: a.deadEndSeedCount,
    candidateCount: a.candidateCount,
    message: a.message,
    witness: {
      delay: w.delay,
      preFaultReceiptLength: w.preFaultReceiptLength,
      faultStepSilent: w.faultTrans.silent,
      postFaultSync: w.postFaultSync,
      postSyncCheck: w.postSyncCheck,
      seedPair: w.seedPair,
      faultTrans: w.faultTrans,
      prefix: w.prefix,
      delayPath: w.delayPath,
      endPair: w.endPair,
      prefixObservable: prefixObs,
      preFaultObservable: preFaultObs,
      delayObservable: delayObs,
      postFaultIdentical: postIdentical,
      nextDistinguishing: {
        faultyReceipts: nd.faultyReceipts,
        normalReceipts: nd.normalReceipts,
        faultyOnly: fOnly,
        normalOnly: nOnly,
        distinguished,
        faultySample: nd.faultySample,
        normalSample: nd.normalSample,
      },
    },
    allDelays: a.allDelays,
  };
}

export function analyze(specText, { mode = 'diagnose' } = {}) {
  const model = parseSpec(specText);
  if (model.errors.length > 0 || model.init === null) {
    return { ok: false, errors: model.errors };
  }
  const diagnosis = diagnose(model);

  if (mode === 'delay') {
    return delayView(model, diagnosis);
  }

  if (diagnosis.diagnosable) {
    return {
      ok: true,
      mode: 'diagnose',
      diagnosable: true,
      stats: statsOf(model, diagnosis),
      checkedPairs: diagnosis.checkedPairs,
    };
  }

  const w = diagnosis.witness;
  const obsOf = (steps) =>
    steps.map((s) => s.receipt).filter((r) => r !== null);
  const prefixObs = obsOf(w.prefix);
  const loopObs = obsOf(w.loop);

  // 校验两侧可观察序列逐元素相同（理论上构造保证，此处再断言式核验）
  const seqF = [];
  const seqN = [];
  for (const s of [...w.prefix, ...w.loop]) {
    if (s.faultySide && !s.faultySide.silent && s.receipt !== null) seqF.push(s.receipt);
    if (s.normalSide && !s.normalSide.silent && s.receipt !== null) seqN.push(s.receipt);
  }
  const identical = seqF.join('') === seqN.join('');

  return {
    ok: true,
    mode: 'diagnose',
    diagnosable: false,
    stats: statsOf(model, diagnosis),
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
    checkedPairs: diagnosis.checkedPairs,
  };
}
