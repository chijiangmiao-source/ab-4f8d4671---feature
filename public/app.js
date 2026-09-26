// app.js — 前端交互：过期任务防护、错误定位、裁决与证据渲染
//   判定（diagnose）：可诊断 / 不可诊断
//   确诊延迟审计（delay）：仅在已判可诊断的现有结论上发起；
//     编辑规程、提交较新审计或取消时清除旧延迟结论，迟到结果不得覆盖草稿。
'use strict';

const $ = (id) => document.getElementById(id);
const ta = $('spec');
const gutter = $('gutter');
const errorsBox = $('errors');
const statusBox = $('status');
const resultBox = $('result');
const submitBtn = $('submit');
const delayBtn = $('delay-audit');
const cancelBtn = $('cancel');
const dirtyFlag = $('dirty');

// 当前任务代次：只有最新一次提交/取消的结果允许落地渲染
let activeJobId = null;
let inflight = false;
let jobCounter = 0;
let lastResultStale = false;  // 规程在得到结果后又被改动
let renderedMode = null;      // 当前结果区展示的结论：'diagnose' | 'delay'
let freshDiagnosable = false; // 最近一次【未被改动】的判定结论为可诊断

const EX_SILENT = `# 静默双环：故障迁移 f1 无回执（SILENT），
# 故障后故障侧 (g1,g2) 与正常侧 (h1,h2) 回执序列都是 a,a,... 完全相同
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

const EX_DIAG = `# 可诊断：故障回执 a 之后故障侧只能收到 b；
# 正常侧对 a 的唯一匹配止于汇点 2，无法无限执行，伪装不能持续
loc 0
loc 1
loc 2
init 0
trans f1 0 1 F a
trans t1 1 1 N b
trans n1 0 2 N a
`;

// 静默有限上界（确诊延迟 = 2）：
//  f1 为静默故障；故障后两侧共同回执 a、b（fsl 为故障侧静默，不增加延迟），
//  随后故障侧在 4 只发 x、正常侧在 7 只发 y，下一可观察回执必然不同。
//  fA 是可观察故障，但正常侧对 a 的唯一匹配止于汇点 9（有限死路），
//  该故障对不能两侧都延续为无限执行，不计入延迟上界。
const EX_DELAY = `# 带静默的有限上界模型（延迟 2）
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

function setText(v) { ta.value = v; ta.dispatchEvent(new Event('input')); }
$('load-silent').addEventListener('click', () => setText(EX_SILENT));
$('load-diag').addEventListener('click', () => setText(EX_DIAG));
$('load-delay').addEventListener('click', () => setText(EX_DELAY));

function syncDelayButton() {
  delayBtn.disabled = inflight || !(freshDiagnosable && !lastResultStale);
}

// ---- 行号槽 ----
function renderGutter(badLines = new Set()) {
  const n = ta.value.split('\n').length;
  gutter.innerHTML = '';
  for (let i = 1; i <= n; i++) {
    const d = document.createElement('div');
    d.textContent = i;
    if (badLines.has(i)) d.className = 'bad';
    gutter.appendChild(d);
  }
}
ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop; });
ta.addEventListener('input', () => {
  renderGutter();
  if (inflight) {
    invalidate('规程在计算期间被修改');
  } else if (activeJobId !== null || renderedMode !== null) {
    lastResultStale = true;
    freshDiagnosable = false;
    syncDelayButton();
    // 编辑规程必须清除旧的延迟结论（判定结论保留并标注过期）
    if (renderedMode === 'delay') {
      renderedMode = null;
      resultBox.innerHTML = '';
      setStatus('idle', '规程已修改 · 旧延迟审计结论已清除，请重新提交判定');
    }
    dirtyFlag.hidden = false;
    dirtyFlag.textContent = '规程已修改 · 当前结果可能过期';
  }
});

// ---- 过期任务处理 ----
async function invalidate(reason) {
  const old = activeJobId;
  inflight = false;
  activeJobId = null;
  freshDiagnosable = false;
  syncDelayButton();
  submitBtn.disabled = false;
  cancelBtn.disabled = true;
  if (old) {
    try { await fetch(`/api/jobs/${encodeURIComponent(old)}`, { method: 'DELETE' }); } catch { /* 忽略 */ }
  }
  // 取消 / 被较新提交取代：清除在途任务对应的（可能已展示的）延迟结论
  if (renderedMode === 'delay') {
    renderedMode = null;
    resultBox.innerHTML = '';
  }
  dirtyFlag.hidden = false;
  dirtyFlag.textContent = `${reason} · 已取消在途任务，旧结果保留但标记过期`;
  setStatus('idle', '在途任务已过期');
}

cancelBtn.addEventListener('click', () => invalidate('已手动取消'));

function setStatus(kind, text, meta = '') {
  statusBox.className = `status ${kind}`;
  statusBox.textContent = text;
  if (meta) {
    const m = document.createElement('span');
    m.className = 'meta';
    m.textContent = meta;
    statusBox.appendChild(m);
  }
}

// ---- 提交（mode: 'diagnose' 判定 | 'delay' 延迟审计）----
submitBtn.addEventListener('click', () => submitSpec('diagnose'));
delayBtn.addEventListener('click', () => submitSpec('delay'));

async function submitSpec(mode) {
  // 新提交取代旧任务；提交即清除旧结论（含旧延迟结论），迟到结果不可能回写
  const previous = activeJobId;
  const jobId = `j${Date.now().toString(36)}-${++jobCounter}`;
  activeJobId = jobId;
  inflight = true;
  lastResultStale = false;
  renderedMode = null;
  dirtyFlag.hidden = true;
  submitBtn.disabled = true;
  delayBtn.disabled = true;
  cancelBtn.disabled = false;
  errorsBox.hidden = true;
  resultBox.innerHTML = '';
  setStatus('computing',
    mode === 'delay'
      ? '确诊延迟审计计算中…（双侧皆活子图 + 最长同步路径，不做有限回放）'
      : '判定计算中…（verifier 同步积 + 环分析）');

  try {
    const resp = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId, supersedes: previous, mode, spec: ta.value }),
    });
    const payload = await resp.json();
    // 过期任务防护：只有仍是当前任务时才允许落地
    if (jobId !== activeJobId) return;
    inflight = false;
    submitBtn.disabled = false;
    cancelBtn.disabled = true;

    // 409：该任务在服务端已被新规程取代或被取消，UI 已由新动作接管，静默
    if (resp.status === 409) return;
    if (!resp.ok) {
      renderFatal(payload.error ?? `请求失败 ${resp.status}`);
      return;
    }
    renderResult(payload.result, mode);
  } catch (err) {
    if (jobId !== activeJobId) return; // 取消导致的中断，忽略
    inflight = false;
    submitBtn.disabled = false;
    cancelBtn.disabled = true;
    syncDelayButton();
    renderFatal(String(err));
  }
}

function renderFatal(msg) {
  setStatus('idle', '未裁决');
  resultBox.innerHTML = '';
  errorsBox.hidden = false;
  errorsBox.innerHTML = `<h3>服务错误</h3><ul><li>${escapeHtml(msg)}</li></ul>`;
}

// ---- 错误定位（同时清除旧结论）----
function renderErrors(errors) {
  // 清除旧结论
  resultBox.innerHTML = '';
  renderedMode = null;
  freshDiagnosable = false;
  syncDelayButton();
  setStatus('idle', '规程非法，未进行裁决（旧结论已清除）');
  const badLines = new Set();
  errorsBox.hidden = false;
  errorsBox.innerHTML = '<h3>录入错误（点击定位）</h3>';
  const ul = document.createElement('ul');
  for (const e of errors) {
    if (e.line > 0) badLines.add(e.line);
    const li = document.createElement('li');
    const where = e.line > 0
      ? `<span class="loc" data-line="${e.line}" data-col="${e.column}">第 ${e.line} 行${e.column ? ` 第 ${e.column} 列` : ''}</span>：`
      : '';
    li.innerHTML = `${where}${escapeHtml(e.message)}`;
    ul.appendChild(li);
  }
  errorsBox.appendChild(ul);
  errorsBox.querySelectorAll('.loc').forEach((el) => {
    el.addEventListener('click', () => jumpTo(Number(el.dataset.line), Number(el.dataset.col)));
  });
  renderGutter(badLines);
}

function jumpTo(line, col) {
  const lines = ta.value.split('\n');
  let offset = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) offset += lines[i].length + 1;
  const lineText = lines[line - 1] ?? '';
  const start = offset + Math.max(0, (col || 1) - 1);
  ta.focus();
  ta.setSelectionRange(start, start + Math.max(1, (lineText.length - (col ? col - 1 : 0))));
  // 行高约 13px * 1.65，保证目标行滚动到可视区
  ta.scrollTop = Math.max(0, line - 6) * 13 * 1.65;
  gutter.scrollTop = ta.scrollTop;
}

// ---- 结果渲染 ----
function renderResult(r, mode) {
  renderGutter();
  if (!r.ok) return renderErrors(r.errors);

  const s = r.stats;
  const meta = `位置 ${s.locations} · 迁移 ${s.transitions}（F ${s.faultyTransitions}）· verifier 状态 ${s.verifierStates}`;

  if (mode === 'delay') return renderDelay(r, meta);

  // 原有判定结论及其证据保持不变
  renderedMode = 'diagnose';
  if (r.diagnosable) {
    freshDiagnosable = true;
    syncDelayButton();
    setStatus('diagnosable', '可诊断：不存在被正常无限执行无限伪装的故障', meta);
    resultBox.innerHTML = checkedPairsCard(r.checkedPairs) + delayHintCard();
    return;
  }
  freshDiagnosable = false;
  syncDelayButton();
  setStatus('nondiag', '不可诊断：存在已发生故障的无限执行与正常无限执行，回执序列完全相同', meta);
  resultBox.innerHTML = witnessCard(r.witness) + checkedPairsCard(r.checkedPairs, true);
}

function delayHintCard() {
  return `<div class="card delay-hint">
    <h3>确诊延迟审计</h3>
    <div class="tabs">
      已判可诊断。可在现有结论上发起审计，确认故障发生后<strong>最多还能出现多少个</strong>
      与始终正常执行相同的可观察回执（静默不增加延迟，同回执同步 +1；只计两侧都能延续为
      无限执行的对，有限死路不计入上界）。
    </div>
  </div>`;
}

// ---- 延迟审计渲染 ----
function renderDelay(r, meta) {
  renderedMode = 'delay';
  freshDiagnosable = r.diagnosable === true && r.finite === true;
  syncDelayButton();

  // 无界伪装：复用现有不可诊断结论，绝不给出有限数字
  if (!r.finite) {
    setStatus('nondiag',
      '延迟审计：仍存在无界伪装 —— 复用不可诊断结论（不给出有限延迟数字）', meta);
    resultBox.innerHTML = unboundedDelayCard(r) +
      (r.reusedNondiagWitness ? witnessCard(r.reusedNondiagWitness) : '') +
      checkedPairsCard(r.checkedPairs, true);
    return;
  }

  setStatus('delay',
    r.winner
      ? `确诊延迟上界 = ${r.delay}：故障后至多再出现 ${r.delay} 个相同可观察回执即必然可区分`
      : '确诊延迟上界 = 0：没有两侧都能无限延续的故障对（死路不计入）',
    meta);

  const cards = [delaySummaryCard(r)];
  if (r.witness) {
    cards.push(delayWitnessCard(r.witness));
    cards.push(delayStepsCard(r.witness));
    cards.push(delayNextCard(r.witness));
  }
  cards.push(checkedPairsCard(r.checkedPairs, true));
  resultBox.innerHTML = cards.join('');
}

function delaySummaryCard(r) {
  const w = r.witness;
  const rows = [
    `<tr><td>有限延迟上界</td><td><b class="big-num">${r.delay}</b> 个故障后的相同可观察回执</td></tr>`,
    `<tr><td>纳入审计的故障对</td><td>${r.seedCount} 对（两侧位置均为活位置，可各自延续为无限执行）</td></tr>`,
    `<tr><td>排除的有限死路对</td><td>${r.deadEndSeedCount} 对（至少一侧不能无限延续，<b>不计入上界</b>）</td></tr>`,
  ];
  if (w) {
    rows.push(`<tr><td>裁决依据</td><td>延迟值降序 → 故障前共同回执长度 ${w.preFaultReceiptLength} → 两侧迁移标识拼接</td></tr>`);
  }
  return `<div class="card">
    <h3>审计摘要</h3>
    <table>${rows.join('')}</table>
    ${w && r.allDelays?.length > 1 ? allDelayRows(r.allDelays) : ''}
  </div>`;
}

function allDelayRows(all) {
  const rows = all.map((x) =>
    `<tr><td><b>${x.delay}</b></td>
     <td class="mono">${escapeHtml(x.seedPair.p)}</td>
     <td class="mono">${escapeHtml(x.seedPair.q)}</td>
     <td class="mono">${escapeHtml(x.faultTransId)}</td>
     <td>${x.preFaultReceiptLength}</td></tr>`).join('');
  return `<h3 style="margin-top:10px">全部双侧皆活故障对的延迟（稳定裁决排序）</h3>
    <table>
      <tr><th>延迟</th><th>故障侧位置</th><th>正常侧位置</th><th>故障迁移</th><th>故障前共同回执长度</th></tr>
      ${rows}
    </table>`;
}

function delayWitnessCard(w) {
  const pre = w.preFaultObservable.map((x) => escapeHtml(x)).join(' ');
  const fault = w.faultTrans;
  const faultDesc = fault.silent
    ? `<span class="tag fsilent">F 静默</span><code>${escapeHtml(fault.transId)}</code> ${escapeHtml(fault.from)} → ${escapeHtml(fault.to)}（无回执，不增加延迟）`
    : `<span class="tag F">F</span><code>${escapeHtml(fault.transId)}</code> ${escapeHtml(fault.from)} → ${escapeHtml(fault.to)} 回执 <code>${escapeHtml(fault.receipt)}</code>`;
  const post = w.delayObservable.map((x) => escapeHtml(x)).join(' ');
  const same = w.postFaultIdentical
    ? '<span style="color:var(--good)">✓ 故障后两侧回执逐元素相同（静默步不计数）</span>'
    : '<span style="color:var(--bad)">✗ 内部校验失败</span>';
  return `
  <div class="card">
    <h3>抵达故障的共同前缀（故障前共同回执长度 ${w.preFaultReceiptLength}）</h3>
    <div class="seq"><span class="prefix-part">${pre || '∅（故障前无任何共同回执）'}</span></div>
    <div class="tabs" style="margin-top:6px">故障置位步：${faultDesc}</div>
    <h3 style="margin-top:10px">达到最大延迟的故障后共同回执（${w.postFaultSync} 个）</h3>
    <div class="seq"><span class="delay-part">${post || '∅'}</span></div>
    <div class="tabs" style="margin-top:6px">${same}</div>
  </div>`;
}

function delayStepsCard(w) {
  // 前缀（含置位步）+ 故障后延迟路径，一张逐步对应表
  return `<div class="card">
    <h3>逐步对应：共同前缀 → 达到最大延迟</h3>
    ${delayStepTable(w.prefix, w.delayPath)}
    <div class="tabs" style="margin-top:8px">
      种子对（故障刚发生）：故障侧 <b>${escapeHtml(w.seedPair.p)}</b> × 正常侧
      <b>${escapeHtml(w.seedPair.q)}</b>；延迟路径止于
      <b>${escapeHtml(w.endPair.p)}</b> × <b>${escapeHtml(w.endPair.q)}</b>，
      此后不存在任何同回执同步。
      <span class="tag fsilent">SILENT 步（延迟 +0）</span><span class="tag sync">同步回执步（延迟 +1）</span>
    </div>
  </div>`;
}

function delayStepTable(prefix, delayPath) {
  const row = (s, phase, i) => {
    const f = s.faultySide;
    const n = s.normalSide;
    const modeTag = s.mode === 'SYNC'
      ? '<span class="tag sync">同步 +1</span>'
      : s.mode === 'F_SILENT'
        ? '<span class="tag fsilent">故障侧静默 +0</span>'
        : '<span class="tag fsilent">正常侧静默 +0</span>';
    const fKind = f.transId ? `<span class="tag ${f.faulty ? 'F' : 'N'}">${f.faulty ? 'F' : 'N'}</span>` : '';
    const side = (x) => x.transId
      ? `${escapeHtml(x.from)} → ${escapeHtml(x.to)} <code>${escapeHtml(x.transId)}</code>${x.silent ? ' <span class="silent">(静默)</span>' : ''}`
      : '<span class="silent">—（本步不动）</span>';
    const phaseLabel = phase === 'prefix' ? `前缀${i + 1}` : `延迟${i + 1}`;
    const cls = phase === 'prefix' ? 'prefixrow' : 'delayrow';
    return `<tr class="${cls}">
      <td>${phaseLabel}</td>
      <td>${modeTag}${s.receipt !== null ? `<code>${escapeHtml(s.receipt)}</code>` : '<span class="silent">ε</span>'}</td>
      <td class="mono">${fKind}${side(f)}</td>
      <td class="mono">${n ? '<span class="tag N">N</span>' : ''}${side(n ?? { transId: null })}</td>
    </tr>`;
  };
  const p = prefix.map((s, i) => row(s, 'prefix', i)).join('');
  const d = delayPath.map((s, i) => row(s, 'delay', i)).join('');
  return `<table class="pair-table">
    <tr><th>阶段</th><th>可观察回执 / 延迟</th><th>故障侧执行（已发生故障）</th><th>正常侧执行（从未故障）</th></tr>
    ${p}${d}
  </table>`;
}

function delayNextCard(w) {
  const nd = w.nextDistinguishing;
  const fList = nd.faultyReceipts.length
    ? nd.faultyReceipts.map((x) => `<code>${escapeHtml(x)}</code>`).join(' ')
    : '<span class="silent">∅（该侧无无限延续）</span>';
  const nList = nd.normalReceipts.length
    ? nd.normalReceipts.map((x) => `<code>${escapeHtml(x)}</code>`).join(' ')
    : '<span class="silent">∅（该侧无无限延续）</span>';
  const fOnly = nd.faultyOnly.length ? nd.faultyOnly.map((x) => `<code>${escapeHtml(x)}</code>`).join(' ') : '—';
  const nOnly = nd.normalOnly.length ? nd.normalOnly.map((x) => `<code>${escapeHtml(x)}</code>`).join(' ') : '—';
  const ok = nd.distinguished
    ? '<span style="color:var(--good)">✓ 两侧下一回执候选不相交：再观察一个回执即可区分</span>'
    : '<span style="color:var(--bad)">✗ 内部校验失败：终点仍存在共同回执</span>';
  return `<div class="card">
    <h3>下一可区分回执</h3>
    <table>
      <tr><th>故障侧可能的下一回执</th><td>${fList}</td></tr>
      <tr><th>正常侧可能的下一回执</th><td>${nList}</td></tr>
      <tr><th>仅故障侧可发</th><td>${fOnly}</td></tr>
      <tr><th>仅正常侧可发</th><td>${nOnly}</td></tr>
    </table>
    <div class="tabs" style="margin-top:6px">${ok}（静默闭包内核对，覆盖 ${nd.silentClosureSize} 个双侧皆活状态）</div>
  </div>`;
}

function unboundedDelayCard(r) {
  return `<div class="card">
    <h3>无界伪装</h3>
    <div class="tabs">
      双侧皆活子图中存在可无限重复的同回执同步环：故障可被始终正常的执行无限期伪装。
      <strong>本结论复用既有“不可诊断”判据，不给出任何有限延迟数字。</strong>
      纳入审计的双侧皆活故障对 ${r.seedCount} 个，排除死路对 ${r.deadEndSeedCount} 个。
    </div>
  </div>`;
}

function witnessCard(w) {
  const seqP = w.prefixObservable.map((x) => escapeHtml(x)).join(' ');
  const seqL = w.loopObservable.map((x) => escapeHtml(x)).join(' ');
  const same = w.sequencesIdentical
    ? '<span style="color:var(--good)">✓ 两侧可观察序列逐元素相同</span>'
    : '<span style="color:var(--bad)">✗ 内部校验失败：序列不一致</span>';
  return `
  <div class="card">
    <h3>最短共同前缀（公共可观察回执长度 ${w.prefixReceiptLength}）</h3>
    <div class="seq"><span class="prefix-part">${seqP || '∅（故障静默，前缀无任何回执）'}</span></div>
    <h3 style="margin-top:12px">可重复闭环（每轮回执长度 ${w.loopReceiptLength}，可无限重复）</h3>
    <div class="seq"><span class="loop-part">[ ${seqL} ] ω</span></div>
    <div class="tabs" style="margin-top:8px">${same}</div>
    <h3 style="margin-top:10px">两侧逐步迁移对应</h3>
    ${stepTable(w.prefix, w.loop)}
    <div class="tabs" style="margin-top:8px">
      入口对：故障侧 <b>${escapeHtml(w.entry.p)}</b> × 正常侧 <b>${escapeHtml(w.entry.q)}</b>；
      故障侧序列＝前缀后无限重复闭环（含 F 迁移）；正常侧序列＝同样回执的无限执行（全程 N）。
      <span class="tag fsilent">SILENT 步</span><span class="tag sync">同步回执步</span>
    </div>
  </div>`;
}

function stepTable(prefix, loop) {
  const row = (s, phase, i) => {
    const f = s.faultySide;
    const n = s.normalSide;
    const modeTag = s.mode === 'SYNC'
      ? '<span class="tag sync">同步</span>'
      : s.mode === 'F_SILENT'
        ? '<span class="tag fsilent">故障侧静默</span>'
        : '<span class="tag fsilent">正常侧静默</span>';
    const fKind = f.transId ? `<span class="tag ${f.faulty ? 'F' : 'N'}">${f.faulty ? 'F' : 'N'}</span>` : '';
    const side = (x) => x.transId
      ? `${escapeHtml(x.from)} → ${escapeHtml(x.to)} <code>${escapeHtml(x.transId)}</code>${x.silent ? ' <span class="silent">(静默)</span>' : ''}`
      : '<span class="silent">—（本步不动）</span>';
    return `<tr class="${phase === 'loop' ? 'looprow' : ''}">
      <td>${phase === 'prefix' ? `前缀${i + 1}` : `闭环${i + 1}`}</td>
      <td>${modeTag}${s.receipt !== null ? `<code>${escapeHtml(s.receipt)}</code>` : '<span class="silent">ε</span>'}</td>
      <td class="mono">${fKind}${side(f)}</td>
      <td class="mono">${n ? '<span class="tag N">N</span>' : ''}${side(n ?? { transId: null })}</td>
    </tr>`;
  };
  const p = prefix.map((s, i) => row(s, 'prefix', i)).join('');
  const l = loop.map((s, i) => row(s, 'loop', i)).join('');
  return `<table class="pair-table">
    <tr><th>阶段</th><th>可观察回执</th><th>故障侧执行（已发生故障）</th><th>正常侧执行（从未故障）</th></tr>
    ${p}${l}
  </table>`;
}

function checkedPairsCard(pairs, compact = false) {
  if (!pairs || pairs.length === 0) {
    return `<div class="card"><h3>已检查的诊断对</h3><div class="tabs">无 f=1 混淆对（系统中没有可被混淆的故障时刻）。</div></div>`;
  }
  const label = {
    ambiguous: '歧义（双侧无限）',
    acyclic: '无环 · 混淆有限',
    'normal-side-stalls': '正常侧停滞 · 非无限',
    'fault-side-stalls': '故障侧停滞',
  };
  const rows = pairs.map((x) =>
    `<tr><td class="mono">${escapeHtml(x.p)}</td><td class="mono">${escapeHtml(x.q)}</td>
     <td>${x.movesF ? '✓' : '—'}</td><td>${x.movesN ? '✓' : '—'}</td>
     <td>${label[x.verdict] ?? x.verdict}</td></tr>`).join('');
  return `<div class="card">
    <h3>已检查的诊断对摘要${compact ? '（节选全部 f=1 可达对）' : ''}</h3>
    <table>
      <tr><th class="mono">故障侧位置</th><th class="mono">正常侧位置</th><th>环内故障侧可动</th><th>环内正常侧可动</th><th>结论</th></tr>
      ${rows}
    </table>
  </div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 初始化
renderGutter();
ta.value = EX_SILENT;
renderGutter();
