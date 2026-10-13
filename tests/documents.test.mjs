import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { KnowledgeDocuments } from '../src/documents.mjs';
import { KnowledgeIndex } from '../src/knowledge.mjs';
import { ProcurementAssistant } from '../src/assistant.mjs';
import { createAppServer } from '../src/http.mjs';
import { ModelProvider } from '../src/provider.mjs';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const base=resolve(project,'work/document-tests');mkdirSync(base,{recursive:true});
const config={mode:'preview',baseUrl:'http://127.0.0.1',apiKey:'',chatModel:'test',embedModel:'test',minSimilarity:0.35,sqlServer:'test',sqlDatabase:'Inventory'};
const note={title:'采购运输检验笔记',version:'1.0',text:'# 运输验收\n\n采购运输检验需核对包装完整，运输检验发现包装破损时，记录破损并复核货物。'};
function fixture(t) {
  const root=mkdtempSync(resolve(base,'case-'));
  for(const dir of ['data','public'])cpSync(resolve(project,dir),resolve(root,dir),{recursive:true});
  t.after(()=>{if(!root.startsWith(base+sep))throw new Error('清理路径越界');rmSync(root,{recursive:true,force:true});});return root;
}
function app(root) {
  const assistant=new ProcurementAssistant(root,config,undefined,{close(){}});
  const {server}=createAppServer(root,config,assistant);server.address=()=>({port:8792});
  // Exercise the actual request handler without opening a client socket.
  const request=(url,options={})=>new Promise(resolveResult=>{
    const raw=options.raw??(options.data===undefined?'':JSON.stringify(options.data));
    const req=Readable.from([Buffer.from(raw)]);req.url=url;req.method=options.method??(options.data===undefined?'GET':'POST');
    req.headers={host:'127.0.0.1:8792','content-type':'application/json',...options.headers};
    const headers={};let status=200;
    const res={setHeader:(key,value)=>{headers[key]=value;},writeHead:(code,values)=>{status=code;Object.assign(headers,values);},end:content=>{
      const text=content?.toString()??'';let data;try{data=JSON.parse(text);}catch{}resolveResult({status,data,text,headers});
    }};
    server.emit('request',req,res);
  });return {assistant,request};
}

test('资料新增与版本更新保留其他资料，并备份旧正文',t=>{
  const root=fixture(t),docs=new KnowledgeDocuments(root),before=docs.manifest();
  const created=docs.save(note);assert.equal(created.status,'active');assert.match(created.file,/^note-.*\.md$/);
  const updated=docs.save({...created,version:'1.1',text:note.text+'\n新增核对签收单。'});
  assert.equal(updated.version,'1.1');assert.notEqual(updated.revision,created.revision);
  assert.deepEqual(docs.manifest().slice(0,before.length),before);
  const dir=resolve(root,'runtime/document-history');
  const backups=readdirSync(dir).map(file=>JSON.parse(readFileSync(resolve(dir,file),'utf8')));
  assert.ok(backups.some(b=>b.document?.text===created.text&&b.document.version==='1.0'));
});
test('拒绝旧页面版本、同名覆盖和大小写变体，不丢失最新正文',t=>{
  const docs=new KnowledgeDocuments(fixture(t)),created=docs.save({...note,file:'note-example.md'});
  const updated=docs.save({...created,version:'1.1',text:'最新正文：运输检验。'});
  for(const value of [{...created,version:'1.2'}, {...note,file:created.file}, {...updated,file:'NOTE-EXAMPLE.md',version:'1.2'}])assert.throws(()=>docs.save(value),error=>error.status===409);
  assert.equal(docs.get(created.file).text,updated.text);
});
test('正文或外部清单改动后，旧 revision 不能继续编辑',t=>{
  const root=fixture(t),docs=new KnowledgeDocuments(root),created=docs.save(note);
  writeFileSync(resolve(root,'data/knowledge',created.file),'外部更新的运输检验正文','utf8');
  assert.throws(()=>docs.save({...created,version:'1.1'}),error=>error.status===409);
  const fresh=docs.get(created.file),manifest=docs.manifest();manifest.find(d=>d.file===created.file).title='外部改标题';docs.writeManifest(manifest);
  assert.throws(()=>docs.setStatus({...fresh,status:'inactive'}),error=>error.status===409);
});
test('空正文、超长正文、无新版本和控制字符均不修改清单',t=>{
  const docs=new KnowledgeDocuments(fixture(t)),created=docs.save(note),before=docs.manifest();
  for(const value of [{...note,text:''},{...note,title:' '},{...note,version:'v\n1'}, {...note,text:'x'.repeat(500001)}, {...note,text:'文本\u0000数据'},created])assert.throws(()=>docs.save(value));
  assert.deepEqual(docs.manifest(),before);assert.equal(docs.get(created.file).text,created.text);
});
test('拒绝越界路径、Windows 特殊文件名和目录伪装',t=>{
  const root=fixture(t),docs=new KnowledgeDocuments(root),before=docs.manifest();
  mkdirSync(resolve(root,'data/knowledge/folder.md'));
  for(const file of ['../outside.md','../../.env','C:\\outside.md','folder.md','con.md','file.exe'])assert.throws(()=>docs.save({...note,file}));
  assert.throws(()=>docs.get('../../.env'),error=>error.status===404);assert.deepEqual(docs.manifest(),before);
});
test('新增、编辑、停用和恢复均更新检索内容及引用版本',async t=>{
  const root=fixture(t),docs=new KnowledgeDocuments(root),index=new KnowledgeIndex(root,config,{}),created=docs.save(note);
  assert.ok((await index.retrieve('运输检验包装破损')).some(s=>s.file===created.file&&s.version==='1.0'));
  const updated=docs.save({...created,version:'1.1',text:note.text+'\n运输检验还应核对签收单。'});
  assert.ok((await index.retrieve('运输检验签收单')).some(s=>s.file===created.file&&s.version==='1.1'));
  const inactive=docs.setStatus({...updated,status:'inactive'});
  assert.ok((await index.retrieve('运输检验签收单')).every(s=>s.file!==created.file));
  assert.equal(docs.get(created.file).text,updated.text);
  docs.setStatus({...inactive,status:'active'});
  assert.ok((await index.retrieve('运输检验签收单')).some(s=>s.file===created.file&&s.version==='1.1'));
});
test('不能停用最后一份有效资料，仍能恢复此前停用的资料',t=>{
  const docs=new KnowledgeDocuments(fixture(t)),manifest=docs.manifest();
  for(const meta of manifest.slice(1))docs.setStatus({...docs.get(meta.file),status:'inactive'});
  assert.throws(()=>docs.setStatus({...docs.get(manifest[0].file),status:'inactive'}),/至少保留一份/);
  docs.setStatus({...docs.get(manifest[1].file),status:'active'});assert.equal(docs.manifest().filter(d=>d.status==='active').length,2);
});
test('网页接口保存后自动读取，停用后状态和片段同步',async t=>{
  const root=fixture(t),{assistant,request}=app(root);
  const saved=await request('/api/documents/save',{data:note});assert.equal(saved.status,200);assert.equal(saved.data.indexReady,true);
  const doc=saved.data.document;assert.ok(assistant.index.corpus.chunks.some(s=>s.file===doc.file));
  const preview=await request('/api/document?file='+doc.file);assert.equal(preview.data.revision,doc.revision);
  const off=await request('/api/documents/status',{data:{file:doc.file,revision:doc.revision,status:'inactive'}});
  assert.equal(off.status,200);assert.equal(off.data.document.status,'inactive');assert.ok(assistant.index.corpus.chunks.every(s=>s.file!==doc.file));
  assert.equal((await request('/api/document?file='+doc.file)).data.text,note.text);
  assert.equal((await request('/api/status')).data.documents.find(d=>d.file===doc.file).status,'inactive');
});
test('接口错误保留 404 与版本冲突 409，拒绝超大请求',async t=>{
  const {request}=app(fixture(t)),saved=(await request('/api/documents/save',{data:note})).data.document;
  assert.equal((await request('/api/document?file=../../.env')).status,404);
  assert.equal((await request('/api/documents/save',{data:{...saved,version:'1.1',revision:'old'}})).status,409);
  assert.equal((await request('/api/documents/status',{data:{file:saved.file,status:'invalid',revision:saved.revision}})).status,400);
  assert.equal((await request('/api/documents/save',{method:'POST',raw:'x'.repeat(2100001)})).status,400);
  assert.equal((await request('/api/documents/save',{method:'POST',raw:'{broken'})).status,400);
});
test('跨站和非本机来源不能修改资料，页面保留禁止脚本注入的响应头',async t=>{
  const root=fixture(t),{request}=app(root),docs=new KnowledgeDocuments(root),before=docs.manifest();
  for(const headers of [{origin:'https://untrusted.example'},{host:'untrusted.example:8792'},{'content-type':'text/plain'}]) {
    const result=await request('/api/documents/save',{data:note,headers});assert.ok([400,403].includes(result.status));
  }
  assert.deepEqual(docs.manifest(),before);
  const page=await request('/');assert.equal(page.status,200);assert.match(page.headers['Content-Security-Policy'],/script-src 'self'/);
});
test('索引失败明确返回已保存，新资料落盘且旧向量失效',async t=>{
  const root=fixture(t),{assistant,request}=app(root);
  assistant.index=new KnowledgeIndex(root,{...config,mode:'online'},{embed:async()=>{throw new Error('模拟接口暂时不可用');}});assistant.index.vectors=[[1,0]];
  const result=await request('/api/documents/save',{data:note});assert.equal(result.status,200);assert.equal(result.data.saved,true);assert.equal(result.data.indexReady,false);assert.match(result.data.warning,/模拟接口暂时不可用/);
  assert.equal(new KnowledgeDocuments(root).get(result.data.document.file).text,note.text);
  assert.equal(assistant.index.vectors,null);assert.ok(assistant.index.corpus.chunks.some(s=>s.file===result.data.document.file));
});
test('问答执行期间拒绝并发修改，原始资料保持完整',async t=>{
  const root=fixture(t),{assistant,request}=app(root),before=new KnowledgeDocuments(root).manifest();
  let release,entered;const started=new Promise(r=>{entered=r;});
  assistant.ask=async()=>{entered();return new Promise(r=>{release=r;});};
  const pending=request('/api/ask',{data:{question:'运输检验'}});await started;
  try {
    const second=await request('/api/documents/save',{data:note});assert.equal(second.status,409);
    assert.deepEqual(new KnowledgeDocuments(root).manifest(),before);
  }finally{release({kind:'preview',answer:'测试完成'});await pending;}
  assert.equal((await request('/api/status')).data.busy,false);
});
test('模型协议与范围提示检查使用模拟响应，不代表真实模型回答',async()=>{
  const provider=new ModelProvider(config);let bad=false;
  provider.request=async(endpoint,payload)=>{
    if(endpoint==='embeddings')return {data:payload.input.map((_,index)=>({index,embedding:[index+1,1]})).reverse()};
    assert.match(payload.messages[0].content,/匹配当前订单且匹配当前 GoodsId/);
    return {choices:[{finish_reason:'stop',message:{content:JSON.stringify({supported:true,answer:'根据资料 [K1]',citations:[bad?'K999':'K1']})}}]};
  };
  assert.equal((await provider.embed(Array(12).fill('文本'))).length,12);
  assert.equal((await provider.generate('问题',[{citation:'K1',text:'运输检验'}])).supported,true);
  bad=true;await assert.rejects(()=>provider.generate('问题',[{citation:'K1',text:'运输检验'}]),/来源/);
});
