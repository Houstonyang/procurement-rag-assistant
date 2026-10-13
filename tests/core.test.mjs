import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,cpSync,mkdirSync,mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { resolve,dirname,sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { buildInventoryQuery,parseSqlcmdJson,existingQueries } from '../src/inventory-sql.mjs';
import { SqlServerStore,classify,runSqlcmd } from '../src/orders.mjs';
import { ProcurementAssistant } from '../src/assistant.mjs';
import { createAppServer } from '../src/http.mjs';
import { ModelProvider } from '../src/provider.mjs';
import { readConfig,publicConfig } from '../src/config.mjs';
import { KnowledgeIndex } from '../src/knowledge.mjs';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const base=resolve(project,'work/sqlserver-tests');mkdirSync(base,{recursive:true});
const config={mode:'preview',baseUrl:'http://127.0.0.1',apiKey:'',chatModel:'test',embedModel:'test',minSimilarity:0.35,sqlServer:'test',sqlDatabase:'Inventory'};
function fixture(t){const root=mkdtempSync(resolve(base,'case-'));cpSync(resolve(project,'data'),resolve(root,'data'),{recursive:true});cpSync(resolve(project,'public'),resolve(root,'public'),{recursive:true});t.after(()=>{if(!root.startsWith(base+sep))throw new Error('清理路径越界');rmSync(root,{recursive:true,force:true});});return root;}
const bearing={id:3,orderNo:'PO20260915001',item:'精密轴承',quantity:500,received:300,remaining:200};
const store={get:async ref=>ref.value==='PO20260915001'?{header:{id:3,orderNo:bearing.orderNo,status:'APPROVED',orderDate:'2026-09-15'},lines:[bearing]}:ref.value==='PO20260920001'?{header:{id:5,orderNo:'PO20260920001',status:'DRAFT',orderDate:'2026-09-20'},lines:[]}:null,
  all:async()=>[bearing,{id:4,orderNo:'PO20260918001',item:'气泡膜',quantity:100,received:0,remaining:100},{id:4,orderNo:'PO20260918001',item:'瓦楞纸箱',quantity:300,received:0,remaining:300}],
  details:async()=>[],suppliers:async()=>[{supplier:'样例',orderCount:2,totalAmount:19950}],probe:async()=>({ok:true,identity:{databaseName:'Inventory'}}),close(){}};

test('真实业务号、内部编号与多订单路由',()=>{
  assert.deepEqual(classify('PO20260915001 还差多少').reference,{type:'number',value:'PO20260915001'});assert.deepEqual(classify('订单3还差多少').reference,{type:'id',value:3});assert.equal(classify('PO20260915001和PO20260918001').route,'clarify');
});
test('未实现的库存和不存在的日期口径不会执行 SQL',()=>{
  for(const q of ['查询库存余额','库存预警','列出逾期订单','预计到货日期'])assert.equal(classify(q).route,'unavailable');assert.equal(classify('删除订单3').route,'readonly');assert.equal(classify('收货跟踪表有哪些查询限制').route,'knowledge');
  assert.equal(classify('供应商金额汇总口径是什么').route,'knowledge');assert.equal(classify('哪些订单到齐').completeOnly,true);
});
test('引用只接受精确业务号或正整数，拒绝 SQL 注入和未知操作',()=>{
  for(const value of ["PO20260915001';DROP TABLE dbo.Goods;--",'PO123','x'])assert.throws(()=>buildInventoryQuery('order',{type:'number',value}));
  assert.throws(()=>buildInventoryQuery('order',{type:'id',value:'3;DELETE'}));assert.throws(()=>buildInventoryQuery('order',{type:'id',value:0}));assert.throws(()=>buildInventoryQuery('delete'));
  assert.match(buildInventoryQuery('order',{type:'number',value:bearing.orderNo}),/WHERE po.OrderNo=N'PO20260915001'/);
});
test('sqlcmd JSON 包装可保留中文、空明细和换行转义',()=>{
  const json=JSON.stringify({ok:true,rows:[{item:'精密轴承',remark:'a\nb'}]});assert.deepEqual(parseSqlcmdJson('payload\n---\nRAGJSON_START'+json.slice(0,20)+'\r\n'+json.slice(20)+'RAGJSON_END\n'),JSON.parse(json));assert.throws(()=>parseSqlcmdJson('错误'));
});
test('原三查询在原样例数据的 SQLite 等价回放（不代表 SQL Server 执行）',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    const ids={Goods:'GoodsId',Supplier:'SupplierId',Customer:'CustomerId',Warehouse:'WarehouseId',PurchaseOrder:'OrderId',PurchaseOrderDetail:'DetailId',PurchaseIn:'PurchaseInId',PurchaseInDetail:'DetailId'};
    const sample=readFileSync(resolve(project,'tests/inventory-sample.sql'),'utf8').replace(/--[^\n]*/g,'');
    for(const match of sample.matchAll(/insert\s+into\s+dbo\.(\w+)\s*\(([^)]+)\)\s*values\s*([\s\S]*?);/gi)){
      const [,table,columnList,values]=match;assert.ok(ids[table]);
      const columns=columnList.split(',').map(x=>x.trim());
      db.exec(`CREATE TABLE ${table} (${ids[table]} INTEGER PRIMARY KEY,${columns.map(c=>c+' '+(/Id$|Quantity|Price|Amount/.test(c)?'NUMERIC':'TEXT')).join(',')});`);
      db.exec(`INSERT INTO ${table} (${columnList}) VALUES ${values.replace(/\bN'/gi,"'")};`);
    }
    const equivalent=q=>q.replace(/dbo\./g,'').replace(/ISNULL\(/g,'IFNULL(');
    const tracking=db.prepare(equivalent(existingQueries.tracking)).all();assert.equal(tracking.length,9);
    const row=tracking.find(r=>r.orderNo==='PO20260915001');assert.equal(row.quantity,500);assert.equal(row.received,300);assert.equal(row.remaining,200);
    assert.equal(db.prepare(equivalent(existingQueries.details)).all().length,9);assert.deepEqual(db.prepare(equivalent(existingQueries.suppliers)).all().map(r=>r.totalAmount),[19950,12500,8300,6540]);
    assert.equal(tracking.filter(r=>r.orderNo==='PO20260918001').length,2);assert.ok(!tracking.some(r=>r.orderNo==='PO20260920001'));
  }finally{db.close();}
});
test('收货匹配与供应商名称分组保留原有口径',()=>{
  assert.match(existingQueries.tracking,/ind.GoodsId=od.GoodsId/);assert.ok(!existingQueries.tracking.includes('Status'));assert.match(existingQueries.suppliers,/GROUP BY s.SupplierName/);assert.ok(!existingQueries.suppliers.includes('GROUP BY s.SupplierId'));
});
test('订单答案保留商品行与原状态，不推断逾期；草稿不编造数量',async t=>{
  const a=new ProcurementAssistant(fixture(t),config,undefined,store);const r=await a.ask('PO20260915001还差多少');assert.equal(r.rows[0].remaining,200);assert.equal(r.header.status,'APPROVED');assert.ok(!r.answer.includes('逾期'));assert.equal(r.sources[0].title,'SQL Server / Inventory');
  const draft=await a.ask('PO20260920001状态是什么');assert.equal(draft.rows.length,0);assert.match(draft.answer,/没有明细/);assert.equal((await a.ask('订单99999')).kind,'refused');
});
test('供应商金额来自原订单明细，列表逐行输出不合计异种商品',async t=>{
  const a=new ProcurementAssistant(fixture(t),config,undefined,store);assert.match((await a.ask('供应商采购金额汇总')).answer,/19950.00/);const r=await a.ask('列出待收清单');assert.equal(r.rows.length,3);assert.match(r.answer,/气泡膜/);assert.match(r.answer,/瓦楞纸箱/);assert.ok(!r.answer.includes('总待收'));
});
test('真实连接失败直接报错，不返回旧模拟数据',async t=>{
  const s=new SqlServerStore(project,config,async()=>{throw new Error('模拟管道拒绝');});const a=new ProcurementAssistant(fixture(t),config,undefined,s);await assert.rejects(()=>a.ask('PO20260915001还差多少'),/管道拒绝/);assert.equal(a.status().databaseDriver,'sqlserver');
});
test('sqlcmd 错误保留驱动诊断，使用 Windows 登录且不通过 shell',async()=>{
  const execute=(binary,args,options,callback)=>{
    assert.ok(args.includes('-E'));assert.ok(args.includes('-N'));assert.ok(args.includes('-C'));assert.equal(options.shell,undefined);assert.equal(options.windowsHide,true);
    callback(Object.assign(new Error('failed'),{code:1}),'','Login failed for user. Cannot open database Inventory.');
  };
  await assert.rejects(()=>runSqlcmd(config,buildInventoryQuery('identity'),execute),error=>error.driverDetail.includes('Cannot open database Inventory')&&error.exitCode===1);
});
test('空明细数组有效，缺失明细字段明确报错',async()=>{
  const empty=new SqlServerStore(project,config,async()=>({ok:true,header:{status:'DRAFT'},rows:[]}));assert.deepEqual((await empty.get({type:'id',value:5})).lines,[]);
  const missing=new SqlServerStore(project,config,async()=>({ok:true,header:{status:'DRAFT'}}));await assert.rejects(()=>missing.get({type:'id',value:5}),/order 查询未返回明细数组/);
});
test('sqlcmd Unicode 与旧代码页输出都保留中文商品及数量',async()=>{
  const expected={ok:true,rows:[{item:'精密轴承',quantity:500,received:300,remaining:200}]};
  const unicode=Buffer.from('\uFEFFpayload\r\nRAGJSON_START'+JSON.stringify(expected)+'RAGJSON_END\r\n','utf16le');
  const legacy=Buffer.concat([Buffer.from('RAGJSON_START{"ok":true,"rows":[{"item":"'),Buffer.from('beabc3dcd6e1b3d0','hex'),Buffer.from('","quantity":500,"received":300,"remaining":200}]}RAGJSON_END')]);
  for(const output of [unicode,legacy]){
    const execute=(binary,args,options,callback)=>{assert.ok(args.includes('-u'));callback(null,output,Buffer.alloc(0));};
    assert.deepEqual(await runSqlcmd(config,buildInventoryQuery('tracking'),execute),expected);
  }
});
test('README 资料检索与来源更新、缓存停用',async t=>{
  const root=fixture(t),a=new ProcurementAssistant(root,config,undefined,store);const r=await a.ask('收货跟踪有哪些查询限制');assert.equal(r.kind,'preview');assert.ok(r.sources.some(s=>s.file==='inventory-readme.md'||s.file==='inventory-integration.md'));assert.ok(r.sources.every(s=>s.lineStart>0));
  let calls=0;const index=new KnowledgeIndex(root,{...config,mode:'online'},{embed:async texts=>{calls++;return texts.map(()=>[1,0]);}});await index.rebuild();const n=calls;await index.rebuild();assert.equal(calls,n);
  const manifestFile=resolve(root,'data/manifest.json'),manifest=JSON.parse(readFileSync(manifestFile,'utf8'));manifest[1].status='inactive';writeFileSync(manifestFile,JSON.stringify(manifest));await index.rebuild();assert.ok(calls>n);assert.ok(index.corpus.chunks.every(c=>c.file!=='inventory-integration.md'));
});
test('公开配置不含 Key，默认指向已确认实例',t=>{
  const c=readConfig(fixture(t),{RAG_API_KEY:'test-secret'});assert.equal(c.sqlServer,'localhost');assert.equal(c.sqlDatabase,'Inventory');assert.ok(!JSON.stringify(publicConfig(c)).includes('test-secret'));
});
test('模型协议模拟测试：批次排序与未知引用拒绝',async t=>{
  let bad=false;const server=createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const data=JSON.parse(Buffer.concat(chunks));res.setHeader('Content-Type','application/json');
    if(req.url==='/embeddings')res.end(JSON.stringify({data:data.input.map((x,index)=>({index,embedding:[index+1,1]})).reverse()}));
    else res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({supported:true,answer:'依据 [K1]',citations:[bad?'K999':'K1']})}}]}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const p=new ModelProvider({...config,apiKey:'test',baseUrl:`http://127.0.0.1:${server.address().port}`,enableThinking:'false'});assert.equal((await p.embed(Array(12).fill('文本'))).length,12);const sources=[{citation:'K1',title:'来源',text:'当前查询'}];assert.equal((await p.generate('问题',sources)).supported,true);bad=true;await assert.rejects(()=>p.generate('问题',sources),/来源/);
});
test('本机网页 HTTP 与 SQL 接入路由（数据库结果模拟）',async t=>{
  const root=fixture(t),a=new ProcurementAssistant(root,config,undefined,store),{server}=createAppServer(root,config,a);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const url=`http://127.0.0.1:${server.address().port}`;
  assert.match(await(await fetch(url)).text(),/SQL Server 收货跟踪/);assert.equal((await fetch(url+'/app.js')).status,200);
  const post=(path,data)=>fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  assert.equal((await(await post('/api/ask',{question:'PO20260915001还差多少'})).json()).rows[0].remaining,200);
  assert.equal((await(await fetch(url+'/api/orders')).json()).databaseDriver,'sqlserver');assert.equal((await post('/api/database-check',{})).status,200);
  assert.equal((await fetch(url+'/api/document?file=../../.env')).status,404);assert.equal((await post('/api/ask',{question:''})).status,400);
});
