import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from './config.mjs';
import { createAppServer } from './http.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const config=readConfig(root);
const {server,assistant}=createAppServer(root,config);
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?`端口 ${config.port} 已被使用。请关闭已有服务，或修改 .env 中的 RAG_PORT。`:'本地服务启动失败。');assistant.close();process.exitCode=1;});
server.listen(config.port,'127.0.0.1',()=>console.log(`采购知识助手：http://127.0.0.1:${config.port} · ${config.mode==='preview'?'检索预览':'模型模式'}`));
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>server.close(()=>{assistant.close();process.exit(0);}));
