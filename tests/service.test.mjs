import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { serviceStatus, stopBackground } from '../src/background-service.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = resolve(project, 'work/background-tests');
const execute = promisify(execFile);
mkdirSync(base, { recursive: true });
async function freePort() {
  const listener = createServer();
  await new Promise(accept => listener.listen(0, '127.0.0.1', accept));
  const port = listener.address().port;
  await new Promise(accept => listener.close(accept));
  return port;
}
async function waitForExit(pid) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await delay(100);
  }
  throw new Error('后台进程没有退出。');
}
function fixture(t, port) {
  const root = mkdtempSync(resolve(base, 'case-'));
  for (const directory of ['src', 'scripts', 'data', 'public']) cpSync(resolve(project, directory), resolve(root, directory), { recursive: true });
  writeFileSync(resolve(root, '.env'), `RAG_MODE=preview\nRAG_API_KEY=\nRAG_PORT=${port}\n`);
  t.after(async () => {
    const running = await serviceStatus(root);
    await stopBackground(root);
    if (running) await waitForExit(running.pid);
    if (!root.startsWith(base + sep)) throw new Error('清理路径越界');
    // Windows 在服务退出的最后一刻可能仍持有日志和工作目录句柄。
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  return root;
}
function command(root, port, action) {
  return execute(process.execPath, [resolve(root, 'scripts/service.mjs'), action], {
    cwd: root, windowsHide: true, timeout: 20000,
    env: { ...process.env, RAG_MODE: 'preview', RAG_API_KEY: '', RAG_PORT: String(port) }
  });
}

test('真实后台进程在启动器退出后继续服务，重复启动与身份校验停止', { timeout: 30000 }, async t => {
  const port = await freePort(), root = fixture(t, port);
  const concurrent = await Promise.all([command(root, port, 'start'), command(root, port, 'start')]);
  assert.ok(concurrent.some(result => /后台服务已启动/.test(result.stdout)));
  assert.ok(concurrent.some(result => /已在运行/.test(result.stdout)));
  const first = await serviceStatus(root);
  assert.equal(first.ready, true);
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/status`)).json()).mode, 'preview');
  assert.match((await command(root, port, 'start')).stdout, /已在运行/);
  assert.equal((await serviceStatus(root)).pid, first.pid);

  const stateFile = resolve(root, 'runtime/service.json');
  const originalState = readFileSync(stateFile, 'utf8');
  const state = JSON.parse(originalState);
  writeFileSync(stateFile, JSON.stringify({ ...state, token: '0'.repeat(64), pid: process.pid }));
  try {
    await assert.rejects(() => stopBackground(root), error => error.code === 'EAUTH');
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/status`)).status, 200);
  } finally { writeFileSync(stateFile, originalState); }

  assert.match((await command(root, port, 'stop')).stdout, /已停止/);
  await waitForExit(first.pid);
  assert.equal(await serviceStatus(root), null);
  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/api/status`));
  assert.match((await command(root, port, 'stop')).stdout, /没有正在运行/);
  assert.match((await command(root, port, 'start')).stdout, /后台服务已启动/);
  assert.equal((await serviceStatus(root)).ready, true);
});

test('端口占用时报错，保留已有服务，不留下运行状态', { timeout: 30000 }, async t => {
  const listener = createServer((_req, res) => res.end('existing-service'));
  await new Promise(accept => listener.listen(0, '127.0.0.1', accept));
  t.after(() => new Promise(accept => listener.close(accept)));
  const port = listener.address().port, root = fixture(t, port);
  await assert.rejects(() => command(root, port, 'start'), error => /端口.*可能已被占用/.test(error.stderr));
  assert.equal(await serviceStatus(root), null);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'existing-service');
});
