// test/server.test.mjs — HTTP 集成测试（临时端口启动真实服务）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { server } from '../server.js';

let base;
before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${addr.port}`;
});
after(async () => { await new Promise((r) => server.close(r)); });

const post = async (path, body) => {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
};

test('健康检查响应', async () => {
  const r = await fetch(`${base}/healthz`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.status, 'ok');
  assert.equal(typeof j.activeJobs, 'number');
});

test('静默双环经 HTTP 判为不可诊断，证据完整', async () => {
  const spec = [
    'loc 0', 'loc 1', 'loc 2', 'loc 3', 'init 0',
    'trans f1 0 1 F SILENT',
    'trans g1 1 2 N a', 'trans g2 2 1 N a',
    'trans h1 0 3 N a', 'trans h2 3 0 N a',
  ].join('\n');
  const { status, json } = await post('/api/analyze', { jobId: 't1', spec });
  assert.equal(status, 200);
  assert.equal(json.result.diagnosable, false);
  assert.equal(json.result.witness.prefixReceiptLength, 0);
  assert.ok(json.result.witness.sequencesIdentical);
  assert.ok(json.result.witness.loopReceiptLength >= 1);
});

test('可诊断回执经 HTTP 判为可诊断', async () => {
  const spec = 'loc 0\nloc 1\nloc 2\ninit 0\ntrans f1 0 1 F a\ntrans t1 1 1 N b\ntrans n1 0 2 N a\n';
  const { status, json } = await post('/api/analyze', { jobId: 't2', spec });
  assert.equal(status, 200);
  assert.equal(json.result.diagnosable, true);
});

test('悬空目标返回定位错误且无结论', async () => {
  const { status, json } = await post('/api/analyze',
    { jobId: 't3', spec: 'loc 0\ninit 0\ntrans t1 0 ZZ N ok\n' });
  assert.equal(status, 200);
  assert.equal(json.result.ok, false);
  const e = json.result.errors.find((x) => x.message.includes('悬空目标'));
  assert.ok(e);
  assert.equal(e.line, 3);
  assert.equal(e.column, 12);
});

test('非法 jobId 400、非法 JSON 400、未知路径 404、穿越被拦', async () => {
  const r1 = await post('/api/analyze', { jobId: '../x', spec: '' });
  assert.equal(r1.status, 400);

  const r2 = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{nope',
  });
  assert.equal(r2.status, 400);

  const r3 = await fetch(`${base}/../etc/passwd`);
  assert.notEqual(r3.status, 200);
});

test('取消不存在的任务返回 cancelled=false', async () => {
  const r = await fetch(`${base}/api/jobs/nope`, { method: 'DELETE' });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.cancelled, false);
});

// 带静默的有限上界模型：静默故障 + 两个同步 a（夹一步静默）⇒ 确诊延迟 2
const DELAY_FINITE = [
  'loc 0', 'loc 1', 'loc 2', 'loc 3', 'loc 4', 'loc 5', 'init 0',
  'trans f1 0 1 F SILENT',
  'trans g1 1 2 N a', 'trans g2 2 3 N SILENT', 'trans g3 3 4 N a', 'trans g4 4 4 N c',
  'trans n1 0 5 N a', 'trans n2 5 5 N a',
].join('\n');

test('确诊延迟审计：带静默的有限上界经 HTTP 得出延迟 2', async () => {
  const { status, json } = await post('/api/delay', { jobId: 'd1', spec: DELAY_FINITE });
  assert.equal(status, 200);
  assert.equal(json.result.diagnosable, true);
  assert.equal(json.result.delay.value, 2);
  const w = json.result.delay.witness;
  assert.equal(w.preFaultReceipts, 0);
  assert.deepEqual(w.tail.map((s) => s.mode), ['SYNC', 'F_SILENT', 'SYNC']);
  assert.equal(w.nextDistinguishing.receipt, 'c');
  assert.equal(w.sequencesIdentical, true);
});

test('确诊延迟审计：无界伪装复用不可诊断结论', async () => {
  const spec = [
    'loc 0', 'loc 1', 'loc 2', 'loc 3', 'init 0',
    'trans f1 0 1 F SILENT',
    'trans g1 1 2 N a', 'trans g2 2 1 N a',
    'trans h1 0 3 N a', 'trans h2 3 0 N a',
  ].join('\n');
  const { status, json } = await post('/api/delay', { jobId: 'd2', spec });
  assert.equal(status, 200);
  assert.equal(json.result.diagnosable, false);
  assert.equal(json.result.delayUnbounded, true);
  assert.equal(json.result.delay, undefined, '不得给出有限延迟数字');
  assert.ok(json.result.witness.loopReceiptLength >= 1, '保留原不可诊断证据');
});

test('确诊延迟审计：死路不计入上界', async () => {
  const spec = [
    'loc 0', 'loc 1', 'loc 2', 'loc 3', 'loc 4', 'loc 5',
    'loc 6', 'loc 7', 'loc 8', 'loc 9', 'init 0',
    'trans f1 0 1 F SILENT',
    'trans ga 1 2 N a', 'trans gc 2 2 N c',
    'trans gb1 1 3 N b', 'trans gb2 3 4 N b', 'trans gb3 4 5 N b',
    'trans na 0 6 N a', 'trans na2 6 6 N a',
    'trans nb1 0 7 N b', 'trans nb2 7 8 N b', 'trans nb3 8 9 N b',
  ].join('\n');
  const { status, json } = await post('/api/delay', { jobId: 'd3', spec });
  assert.equal(status, 200);
  assert.equal(json.result.diagnosable, true);
  assert.equal(json.result.delay.value, 1, '死路分支的 3 步同步不得计入上界');
});

test('原有判定接口回归：/api/analyze 不附带延迟结论', async () => {
  const { status, json } = await post('/api/analyze', { jobId: 'd4', spec: DELAY_FINITE });
  assert.equal(status, 200);
  assert.equal(json.result.diagnosable, true);
  assert.equal(json.result.delay, undefined);
});

test('延迟审计的非法规程返回定位错误且无结论', async () => {
  const { status, json } = await post('/api/delay',
    { jobId: 'd5', spec: 'loc 0\ninit 0\ntrans t1 0 ZZ N ok\n' });
  assert.equal(status, 200);
  assert.equal(json.result.ok, false);
  const e = json.result.errors.find((x) => x.message.includes('悬空目标'));
  assert.ok(e);
  assert.equal(e.line, 3);
  assert.equal(json.result.delay, undefined);
});
