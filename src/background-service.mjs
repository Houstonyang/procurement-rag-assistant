import { createHash, randomBytes } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from './config.mjs';
import { createAppServer } from './http.mjs';

const statePath = root => resolve(root, 'runtime/service.json');
const disconnected = error => ['ENOENT', 'ECONNREFUSED', 'EPIPE', 'ECONNRESET'].includes(error.code);
export function controlPath(root) {
  const canonical = realpathSync(root);
  const id = createHash('sha256').update(process.platform === 'win32' ? canonical.toLowerCase() : canonical).digest('hex').slice(0, 32);
  return process.platform === 'win32' ? `\\\\.\\pipe\\procurement-rag-${id}` : resolve(root, 'runtime/service.sock');
}
function readState(root) {
  try {
    const state = JSON.parse(readFileSync(statePath(root), 'utf8'));
    return /^[a-f0-9]{64}$/.test(state.token) ? state : null;
  } catch { return null; }
}
function removeState(root, token) {
  if (readState(root)?.token === token) unlinkSync(statePath(root));
}
export function controlRequest(root, token, action, timeout = 1500) {
  return new Promise((resolveRequest, reject) => {
    const socket = createConnection(controlPath(root));
    let received = '', settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; socket.destroy();
      error ? reject(error) : resolveRequest(result);
    };
    socket.setTimeout(timeout, () => finish(Object.assign(new Error('后台服务响应超时。'), { code: 'ETIMEDOUT' })));
    socket.on('error', error => finish(error));
    socket.on('connect', () => socket.write(JSON.stringify({ token, action }) + '\n'));
    socket.on('data', chunk => {
      received += chunk.toString('utf8');
      if (received.length > 4096) return finish(new Error('后台服务响应格式错误。'));
      if (!received.includes('\n')) return;
      try {
        const result = JSON.parse(received.split('\n')[0]);
        if (!result.ok) return finish(Object.assign(new Error(result.error), { code: 'EAUTH' }));
        finish(null, result);
      } catch (error) { finish(error); }
    });
    socket.on('end', () => { if (!settled) finish(Object.assign(new Error('后台服务连接已关闭。'), { code: 'ECONNRESET' })); });
  });
}
export async function serviceStatus(root) {
  const state = readState(root);
  if (!state) return null;
  try { return await controlRequest(root, state.token, 'status'); }
  catch (error) {
    if (disconnected(error)) return null;
    throw error;
  }
}
export async function startBackground(root) {
  const existing = await serviceStatus(root);
  if (existing) {
    if (!existing.ready) throw new Error('服务正在停止，请稍后重新启动。');
    return { ...existing, alreadyRunning: true };
  }
  const config = readConfig(root);
  mkdirSync(resolve(root, 'runtime'), { recursive: true });
  const token = randomBytes(32).toString('hex');
  const stdout = openSync(resolve(root, 'runtime/service.stdout.log'), 'a');
  const stderr = openSync(resolve(root, 'runtime/service.stderr.log'), 'a');
  let child, launchError, exitCode;
  try {
    child = spawn(process.execPath, [resolve(root, 'scripts/service.mjs'), 'run'], {
      cwd: root, detached: true, windowsHide: true, stdio: ['ignore', stdout, stderr],
      env: { ...process.env, PROCUREMENT_RAG_SERVICE_TOKEN: token }
    });
    child.on('error', error => { launchError = error; });
    child.on('exit', code => { exitCode = code; });
    child.unref();
  } finally { closeSync(stdout); closeSync(stderr); }
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (launchError) throw new Error('无法启动 Node.js 后台进程。');
    try {
      const status = await controlRequest(root, token, 'status', 500);
      if (status.ready) return { ...status, alreadyRunning: false };
    } catch (error) {
      // 两次双击可能同时启动；只有占有此目录控制管道的进程可以保存状态。
      if (error.code === 'EAUTH') {
        const current = await serviceStatus(root);
        if (current?.ready) return { ...current, alreadyRunning: true };
      }
    }
    if (exitCode !== undefined) break;
    await delay(100);
  }
  throw new Error(`后台启动失败。端口 ${config.port} 可能已被占用；若旧版启动窗口还开着，请先按 Ctrl+C 关闭旧服务。详情见 runtime/service.stderr.log。`);
}
export async function stopBackground(root) {
  const state = readState(root);
  if (!state) return { stopped: false };
  try { await controlRequest(root, state.token, 'stop'); }
  catch (error) {
    if (disconnected(error)) { removeState(root, state.token); return { stopped: false }; }
    throw error;
  }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try { await controlRequest(root, state.token, 'status', 500); }
    catch (error) {
      if (disconnected(error)) { removeState(root, state.token); return { stopped: true }; }
      if (error.code === 'EAUTH') return { stopped: true }; // 已有另一轮启动，不停止新进程。
      throw error;
    }
    await delay(100);
  }
  throw new Error('服务还未停止，请稍后再试；没有按 PID 强制终止其他进程。');
}
export async function runBackground(root) {
  const token = process.env.PROCUREMENT_RAG_SERVICE_TOKEN;
  delete process.env.PROCUREMENT_RAG_SERVICE_TOKEN;
  if (!/^[a-f0-9]{64}$/.test(token ?? '')) throw new Error('请通过“启动.cmd”启动后台服务。');
  const config = readConfig(root);
  const { server, assistant } = createAppServer(root, config);
  let ready = false, stopping = false, finished = false;
  const clients = new Set();
  const control = createServer(socket => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    let received = '';
    socket.setTimeout(2000, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.on('data', chunk => {
      received += chunk.toString('utf8');
      if (received.length > 4096) return socket.destroy();
      if (!received.includes('\n')) return;
      socket.removeAllListeners('data');
      let request;
      try { request = JSON.parse(received.split('\n')[0]); } catch { return socket.destroy(); }
      if (request.token !== token || !['status', 'stop'].includes(request.action)) {
        socket.end(JSON.stringify({ ok: false, error: '后台服务身份校验失败；没有停止任何进程。' }) + '\n'); return;
      }
      socket.end(JSON.stringify({ ok: true, ready, pid: process.pid, port: config.port }) + '\n', () => {
        if (request.action === 'stop') shutdown();
      });
    });
  });
  function finish() {
    if (finished) return;
    finished = true;
    assistant.close();
    removeState(root, token);
    for (const socket of clients) socket.destroy();
    control.close();
    process.exit(0);
  }
  function shutdown() {
    if (stopping) return;
    stopping = true; ready = false;
    const timer = setTimeout(() => { server.closeAllConnections(); finish(); }, 5000);
    timer.unref();
    server.close(() => { clearTimeout(timer); finish(); });
  }
  try {
    await new Promise((accept, reject) => { control.once('error', reject); control.listen(controlPath(root), accept); });
    await new Promise((accept, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', accept); });
    const state = { pid: process.pid, port: config.port, startedAt: new Date().toISOString(), token };
    const temporary = statePath(root) + `.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(temporary, statePath(root));
    ready = true;
    console.log(`${state.startedAt} 后台服务已启动：http://127.0.0.1:${config.port}`);
    process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  } catch (error) {
    server.close(); control.close(); assistant.close();
    removeState(root, token);
    if (error.code === 'EADDRINUSE') throw new Error(`端口 ${config.port} 或本目录后台服务已被占用。`);
    throw error;
  }
}
