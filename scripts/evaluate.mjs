import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { ProcurementAssistant } from '../src/assistant.mjs';
import { readConfig } from '../src/config.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const online=process.argv.includes('--online');
const config=readConfig(root);
config.mode=online?'online':'preview';
if(online&&!config.apiKey){console.error('在线验收需要先配置 .env 中的 RAG_API_KEY。此次没有进行模型测试。');process.exit(1);}
const assistant=new ProcurementAssistant(root,config);
const rows=[];
try {
  for(const c of JSON.parse(readFileSync(resolve(root,'data/evaluation.json'),'utf8'))) {
    try {
      const r=await assistant.ask(c.question);const failures=[];
      if(r.route!==c.route)failures.push('路由不符');
      const expected=online?(c.onlineKind??c.kind):(c.kind??'preview');
      if(r.kind!==expected)failures.push(`结果类型：${r.kind}，预期 ${expected}`);
      if(c.source&&!(r.candidates??r.sources).some(s=>s.file===c.source))failures.push('期望文档未进入候选');
      rows.push({id:c.id,question:c.question,passed:!failures.length,failures,result:r,manualReview:c.review??null,manualReviewStatus:c.review?'待人工核对':'不适用'});
      console.log(`${failures.length?'FAIL':'PASS'} ${c.id}: ${c.question}`);
    } catch(error){rows.push({id:c.id,question:c.question,passed:false,failures:[error.message]});console.log(`FAIL ${c.id}: ${error.message}`);}
  }
} finally {assistant.close();}
const passed=rows.filter(x=>x.passed).length;
const report={date:new Date().toISOString().slice(0,10),executedAt:new Date().toISOString(),mode:online?'online':'preview',scope:online?'真实模型知识问答；答案事实性需人工复核；SQL另行验收':'项目资料本地检索与范围检查；不调用模型或SQL Server',passed,total:rows.length,rows};
mkdirSync(resolve(root,'reports'),{recursive:true});writeFileSync(resolve(root,`reports/${online?'online':'preview'}-evaluation.json`),JSON.stringify(report,null,2));
console.log(`${passed}/${rows.length} 自动检查通过。${online?'规则答案请逐题人工核对。':'完整 RAG 生成尚未验收。'}`);
if(passed!==rows.length)process.exitCode=1;
