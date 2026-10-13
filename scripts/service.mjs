import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBackground, stopBackground, serviceStatus, runBackground } from '../src/background-service.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  const action = process.argv[2] ?? 'start';
  if (action === 'run') await runBackground(root);
  else if (action === 'start') {
    const result = await startBackground(root);
    console.log(`${result.alreadyRunning ? '后台服务已在运行' : '后台服务已启动'}：http://127.0.0.1:${result.port}/`);
    console.log('启动窗口会自动关闭。需要停止时，双击“停止服务.cmd”。');
  } else if (action === 'stop') {
    const result = await stopBackground(root);
    console.log(result.stopped ? '本项目后台服务已停止。' : '本项目没有正在运行的后台服务。');
  } else if (action === 'status') {
    const result = await serviceStatus(root);
    console.log(result ? `后台服务${result.ready ? '正在运行' : '正在停止'}：http://127.0.0.1:${result.port}/` : '本项目后台服务未运行。');
  } else throw new Error('用法：node scripts/service.mjs start|stop|status');
} catch (error) { console.error(error.message); process.exitCode = 1; }
