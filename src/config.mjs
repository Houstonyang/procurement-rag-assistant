import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const names = ['RAG_MODE','RAG_API_KEY','RAG_BASE_URL','RAG_CHAT_MODEL','RAG_EMBED_MODEL','RAG_ENABLE_THINKING','RAG_PORT','RAG_MIN_SIMILARITY','RAG_SQL_SERVER','RAG_SQL_DATABASE','RAG_SQLCMD_PATH'];
export function readConfig(root, env = process.env) {
  const local = {};
  const file = resolve(root, '.env');
  if (existsSync(file)) for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && names.includes(m[1])) local[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  const value = (name, fallback) => env[name] ?? local[name] ?? fallback;
  const config = {
    mode: value('RAG_MODE', 'preview'), apiKey: value('RAG_API_KEY',''),
    baseUrl: value('RAG_BASE_URL','https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, ''),
    chatModel: value('RAG_CHAT_MODEL','qwen-plus'), embedModel: value('RAG_EMBED_MODEL','text-embedding-v4'),
    enableThinking: value('RAG_ENABLE_THINKING','false'),
    port: Number(value('RAG_PORT','8791')), minSimilarity: Number(value('RAG_MIN_SIMILARITY','0.35')),
    sqlServer:value('RAG_SQL_SERVER','localhost'),sqlDatabase:value('RAG_SQL_DATABASE','Inventory'),
    sqlcmdPath:value('RAG_SQLCMD_PATH','C:\\Program Files\\Microsoft SQL Server\\Client SDK\\ODBC\\170\\Tools\\Binn\\SQLCMD.EXE')
  };
  if (!['preview','online'].includes(config.mode)) throw new Error('RAG_MODE 必须为 preview 或 online。');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('端口必须为 1–65535。');
  if (!Number.isFinite(config.minSimilarity) || config.minSimilarity < 0 || config.minSimilarity > 1) throw new Error('向量阈值必须为 0–1。');
  const url = new URL(config.baseUrl);
  if (url.username || url.password || !['https:','http:'].includes(url.protocol)) throw new Error('模型接口地址格式无效。');
  if (url.protocol === 'http:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('远程模型接口必须使用 HTTPS。');
  return config;
}

export function publicConfig(c) {
  return {mode:c.mode, keyConfigured:Boolean(c.apiKey), chatModel:c.chatModel, embedModel:c.embedModel,databaseDriver:'sqlserver',sqlDatabase:c.sqlDatabase};
}
