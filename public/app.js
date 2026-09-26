// app.js — 前端交互：过期任务防护、错误定位、裁决与证据渲染
'use strict';

const $ = (id) => document.getElementById(id);
const ta = $('spec');
const gutter = $('gutter');
const errorsBox = $('errors');
const statusBox = $('status');
const resultBox = $('result');
const submitBtn = $('submit');
const cancelBtn = $('cancel');
const dirtyFlag = $('dirty');

// 当前任务代次：只有最新一次提交/取消的结果允许落地渲染
let activeJobId = null;
let inflight = false;
let jobCounter = 0;
let lastResultStale = false; // 规程在得到结果后又被改动

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

const EX_DELAY = `# 有限延迟（带静默）：静默故障后，故障侧还能与正常侧同步两个回执 a
# （中间夹一步静默迁移），第三个回执 c 正常侧无法匹配 ⇒ 确诊延迟 2
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

function setText(v) { ta.value = v; ta.dispatchEvent(new Event('input')); }
$('load-silent').addEventListener('click', () => setText(EX_SILENT));
$('load-diag').addEventListener('click', () => setText(EX_DIAG));
$('load-delay').addEventListener('click', () => setText(EX_DELAY));

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
  removeDelayConclusion();      // 编辑规程：清除旧的延迟结论
  $('delay-launch')?.remove();  // 延迟审计入口随旧结论一并失效
  if (inflight) invalidate('规程在计算期间被修改');
  else if (activeJobId !== null) { lastResultStale = true; dirtyFlag.hidden = false; }
});

// 清除延迟审计结论（编辑规程 / 提交较新审计 / 取消时调用）
function removeDelayConclusion() {
  $('delay-card')?.remove();
}

// ---- 过期任务处理 ----
async function invalidate(reason) {
  const old = activeJobId;
  inflight = false;
  activeJobId = null;
  submitBtn.disabled = false;
  cancelBtn.disabled = true;
  removeDelayConclusion(); // 取消/取代：清除旧的延迟结论
  const launchBtn = $('delay-launch-btn');
  if (launchBtn) launchBtn.disabled = false;
  if (old) {
    try { await fetch(`/api/jobs/${encodeURIComponent(old)}`, { method: 'DELETE' }); } catch { /* 忽略 */ }
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

// ---- 提交 ----
submitBtn.addEventListener('click', submitSpec);
async function submitSpec() {
  // 新提交取代旧任务
  const previous = activeJobId;
  const jobId = `j${Date.now().toString(36)}-${++jobCounter}`;
  activeJobId = jobId;
  inflight = true;
  lastResultStale = false;
  dirtyFlag.hidden = true;
  submitBtn.disabled = true;
  cancelBtn.disabled = false;
  errorsBox.hidden = true;
  resultBox.innerHTML = '';
  setStatus('computing', '判定计算中…（verifier 同步积 + 环分析）');

  try {
    const resp = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId, supersedes: previous, spec: ta.value }),
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
    renderResult(payload.result);
  } catch (err) {
    if (jobId !== activeJobId) return; // 取消导致的中断，忽略
    inflight = false;
    submitBtn.disabled = false;
    cancelBtn.disabled = true;
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
function renderResult(r) {
  renderGutter();
  if (!r.ok) return renderErrors(r.errors);

  const s = r.stats;
  const meta = `位置 ${s.locations} · 迁移 ${s.transitions}（F ${s.faultyTransitions}）· verifier 状态 ${s.verifierStates}`;
  if (r.diagnosable) {
    setStatus('diagnosable', '可诊断：不存在被正常无限执行无限伪装的故障', meta);
    resultBox.innerHTML = checkedPairsCard(r.checkedPairs) + delayLaunchCard();
    $('delay-launch-btn').addEventListener('click', runDelayAudit);
    return;
  }
  setStatus('nondiag', '不可诊断：存在已发生故障的无限执行与正常无限执行，回执序列完全相同', meta);
  resultBox.innerHTML = witnessCard(r.witness) + checkedPairsCard(r.checkedPairs, true);
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

function stepTable(prefix, second, secondLabel = '闭环') {
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
    return `<tr class="${phase === 'second' ? 'looprow' : ''}">
      <td>${phase === 'prefix' ? `前缀${i + 1}` : `${secondLabel}${i + 1}`}</td>
      <td>${modeTag}${s.receipt !== null ? `<code>${escapeHtml(s.receipt)}</code>` : '<span class="silent">ε</span>'}</td>
      <td class="mono">${fKind}${side(f)}</td>
      <td class="mono">${n ? '<span class="tag N">N</span>' : ''}${side(n ?? { transId: null })}</td>
    </tr>`;
  };
  const p = prefix.map((s, i) => row(s, 'prefix', i)).join('');
  const l = second.map((s, i) => row(s, 'second', i)).join('');
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

// ---- 确诊延迟审计 ----
function delayLaunchCard() {
  return `<div class="card" id="delay-launch">
    <h3>确诊延迟审计</h3>
    <div class="tabs">在可诊断结论上继续精确分析：故障发生后最多还能出现多少个与始终正常执行相同的可观察回执——静默迁移不计、同回执同步计 1、只计两侧都能无限延续的对（死路不计入上界）。</div>
    <button id="delay-launch-btn" type="button">发起确诊延迟审计</button>
  </div>`;
}

async function runDelayAudit() {
  // 新审计取代旧任务；旧延迟结论立即清除
  const previous = activeJobId;
  const jobId = `d${Date.now().toString(36)}-${++jobCounter}`;
  activeJobId = jobId;
  inflight = true;
  submitBtn.disabled = true;
  cancelBtn.disabled = false;
  removeDelayConclusion();
  const launchBtn = $('delay-launch-btn');
  if (launchBtn) launchBtn.disabled = true;
  setStatus('computing', '确诊延迟审计计算中…（可达故障对上的精确最长伪装）');

  try {
    const resp = await fetch('/api/delay', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId, supersedes: previous, spec: ta.value }),
    });
    const payload = await resp.json();
    // 过期任务防护：迟到计算不得覆盖当前草稿
    if (jobId !== activeJobId) return;
    inflight = false;
    submitBtn.disabled = false;
    cancelBtn.disabled = true;
    if (resp.status === 409) return; // 已被取代/取消，UI 由新动作接管
    if (!resp.ok) {
      renderFatal(payload.error ?? `请求失败 ${resp.status}`);
      return;
    }
    renderDelayResult(payload.result);
  } catch (err) {
    if (jobId !== activeJobId) return;
    inflight = false;
    submitBtn.disabled = false;
    cancelBtn.disabled = true;
    renderFatal(String(err));
  }
}

function renderDelayResult(r) {
  const launchBtn = $('delay-launch-btn');
  if (launchBtn) launchBtn.disabled = false;
  if (!r.ok) return renderErrors(r.errors);

  const s = r.stats;
  const meta = `位置 ${s.locations} · 迁移 ${s.transitions}（F ${s.faultyTransitions}）· verifier 状态 ${s.verifierStates}`;
  if (!r.diagnosable) {
    // 仍存在无界伪装：复用不可诊断结论，不给出有限数字
    setStatus('nondiag', '延迟审计：仍存在无界伪装 ⇒ 不可诊断（复用现有结论，不给出有限延迟）', meta);
    resultBox.insertAdjacentHTML('beforeend',
      `<div class="card" id="delay-card"><h3>确诊延迟审计</h3>
       <div class="tabs">仍存在无界伪装，复用不可诊断结论，不提供有限延迟数字。</div></div>`
      + witnessCard(r.witness));
    return;
  }
  setStatus('diagnosable', '可诊断：不存在被正常无限执行无限伪装的故障',
    `${meta} · 确诊延迟 ${r.delay.value} 个回执`);
  resultBox.insertAdjacentHTML('beforeend', delayCard(r));
}

function delayCard(r) {
  const d = r.delay;
  if (!d.witness) {
    return `<div class="card" id="delay-card">
      <h3>确诊延迟审计</h3>
      <div class="seq">最大确诊延迟：<b>0</b> 个可观察回执</div>
      <div class="tabs">故障后不存在两侧都能无限延续的混淆对（可达且双侧可续的故障对 0 个），任何故障后回执都不被计入——死路不计入上界。</div>
    </div>`;
  }
  const w = d.witness;
  const seqP = w.prefixObservable.map((x) => escapeHtml(x)).join(' ');
  const seqT = w.tailObservable.map((x) => escapeHtml(x)).join(' ');
  const same = w.sequencesIdentical
    ? '<span style="color:var(--good)">✓ 前缀+延迟段两侧可观察序列逐元素相同</span>'
    : '<span style="color:var(--bad)">✗ 内部校验失败：序列不一致</span>';
  const next = w.nextDistinguishing
    ? `<code>${escapeHtml(w.nextDistinguishing.receipt)}</code> —— 故障侧迁移 <code>${escapeHtml(w.nextDistinguishing.transId)}</code>（${escapeHtml(w.nextDistinguishing.from)} → ${escapeHtml(w.nextDistinguishing.to)}）可产生且故障侧仍可无限延续；正常侧任何无限执行都无法在此位置匹配该回执`
    : '无 —— 故障侧可在静默中无限延续，不再产生可观察回执';
  return `<div class="card" id="delay-card">
    <h3>确诊延迟审计</h3>
    <div class="seq">最大确诊延迟：<b>${d.value}</b> 个可观察回执（静默迁移不计；同回执同步计 1；死路不计入）</div>
    <div class="tabs">稳定裁决：延迟值最大 · 故障前共同回执长度最小 · 两侧迁移标识最小；两侧可无限延续的可达故障对 ${d.viablePairs} 个</div>
    <h3 style="margin-top:12px">抵达故障的共同前缀（故障前共同回执长度 ${w.preFaultReceipts}，不含故障迁移自身回执）</h3>
    <div class="seq"><span class="prefix-part">${seqP || '∅（故障前无任何回执）'}</span></div>
    <h3 style="margin-top:12px">达到最大延迟的逐步对应（${d.value} 个同步回执）</h3>
    <div class="seq"><span class="loop-part">${seqT || '∅（故障后无可匹配回执）'}</span></div>
    <div class="tabs" style="margin-top:8px">${same}</div>
    <h3 style="margin-top:10px">下一可区分回执</h3>
    <div class="seq">${next}</div>
    <h3 style="margin-top:10px">两侧逐步迁移对应</h3>
    ${stepTable(w.prefix, w.tail, '延迟')}
    <div class="tabs" style="margin-top:8px">
      入口对（故障刚发生）：故障侧 <b>${escapeHtml(w.entry.p)}</b> × 正常侧 <b>${escapeHtml(w.entry.q)}</b>；
      终点对：故障侧 <b>${escapeHtml(w.end.p)}</b> × 正常侧 <b>${escapeHtml(w.end.q)}</b>。
      <span class="tag fsilent">SILENT 步</span><span class="tag sync">同步回执步</span>
    </div>
  </div>`;
}

// 初始化
renderGutter();
ta.value = EX_SILENT;
renderGutter();
