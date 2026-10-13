const $=id=>document.getElementById(id);
const make=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
let working=false,editorDocument=null,viewedFile=null;
function setWorking(value) {
  working=value;
  for(const id of ['submit','rebuild','create-document','save-document','editor-title','editor-version','editor-text','import-document','close-editor'])$(id).disabled=value;
  for(const button of document.querySelectorAll('.doc-action'))button.disabled=value;
}
function editorError(message) {$('editor-error').hidden=!message;$('editor-error').textContent=message||'';}
function maintenance(message,warning=false) {
  $('maintenance-message').hidden=!message;$('maintenance-message').textContent=message||'';
  $('maintenance-message').className=`maintenance-message${warning?' warning':''}`;
}
function refreshMessage(result) {
  maintenance(result.warning||'资料已保存并刷新检索。',!result.indexReady);
  $('result').replaceChildren(make('p','fine',result.indexReady?'资料已更新，可以再次提问。':'资料已保存。请处理接口问题后点击“重新读取资料”，再提问。'));
}
async function api(path,body) {
  const response=await fetch(path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();if(!response.ok)throw new Error(result.error||'请求失败');return result;
}
function error(message) {$('error').hidden=!message;$('error').textContent=message||'';}
function sourceCard(source) {
  const card=make('div','source-card');const heading=make('div','source-heading');
  heading.append(make('span','source-id',source.citation),make('span','source-title',`${source.title} / ${source.section}`));
  const position=source.lineStart?` · 第 ${source.lineStart}–${source.lineEnd} 行`:'';
  card.append(heading,make('p','source-meta',`版本 ${source.version}${position}`),make('pre','source-text',source.text));
  return card;
}
function render(result) {
  const section=$('result');section.replaceChildren();
  const names={preview:'检索预览',sql:'数据库查询',rag:'RAG 回答',refused:'资料不足 / 无法执行',clarify:'补充查询信息'};
  const heading=make('div','result-heading');heading.append(make('span','result-type',names[result.kind]),make('span','result-timing',`${result.durationMs} ms`));
  section.append(heading,make('p','answer',result.answer));
  for(const source of result.sources??[])section.append(sourceCard(source));
  if(result.candidates?.length) {
    const trace=make('details','trace');trace.append(make('summary','',`检索记录 · ${result.candidates.length} 个候选片段`));
    for(const source of result.candidates) {
      const score=source.scores;
      trace.append(make('p','',`${source.citation} · ${source.title} / ${source.section} · BM25 ${score.lexical.toFixed(2)}${score.similarity===null?'':` · 余弦 ${score.similarity.toFixed(3)}`}`));
    }
    section.append(trace);
  }
}
async function ask() {
  if(working)return;
  const question=$('question').value.trim();if(!question)return;
  error('');setWorking(true);$('submit').textContent='正在查询…';
  $('result').replaceChildren(make('p','fine','正在查询依据。首次模型模式会构建向量索引，可能需要稍等。'));
  try{render(await api('/api/ask',{question}));await status();}
  catch(e){error(e.message);$('result').replaceChildren(make('p','fine','本次未取得结果，请处理上方错误后重试。'));}
  finally{setWorking(false);$('submit').textContent='查询依据 →';}
}
async function showDocument(file) {
  try{const doc=await api(`/api/document?file=${encodeURIComponent(file)}`);viewedFile=file;$('document-title').textContent=doc.title;$('document-meta').textContent=`版本 ${doc.version} · ${doc.status==='active'?'有效资料':'已停用，不参与检索'}`;$('document-text').textContent=doc.text;$('document-dialog').showModal();}
  catch(e){error(e.message);}
}
async function status() {
  const state=await api('/api/status');
  const online=state.mode==='online';
  $('mode').textContent=online?(state.keyConfigured?'模型模式 · 已配置接口':'模型模式 · 缺少 Key'):'检索预览 · 模型未接入';
  $('mode').className=`badge ${online?(state.keyConfigured?'online':'problem'):''}`;
  $('preview-note').textContent=online?`模型模式：混合检索 + ${state.chatModel} 回答。采购数据直接查询 SQL Server，模型只回答项目说明问题。`:'知识问答为检索预览。采购数据实时查询 SQL Server，连接失败会报错，不使用旧模拟数据。';
  $('doc-count').textContent=state.documents.filter(d=>d.status==='active').length;$('chunk-count').textContent=state.chunkCount;
  $('documents').replaceChildren();
  for(const doc of state.documents){
    const row=make('div',`document-item ${doc.status==='active'?'':'inactive'}`),button=make('button','doc-row');button.type='button';
    button.append(make('span','',doc.title),make('span','doc-version',doc.status==='active'?`v${doc.version} ↗`:`v${doc.version} · 已停用`));button.addEventListener('click',()=>showDocument(doc.file));
    const actions=make('div','doc-actions'),edit=make('button','doc-action','编辑'),toggle=make('button','doc-action',doc.status==='active'?'停用':'恢复');
    for(const action of [edit,toggle]){action.type='button';action.disabled=working;}
    edit.setAttribute('aria-label',`编辑${doc.title}`);toggle.setAttribute('aria-label',`${doc.status==='active'?'停用':'恢复'}${doc.title}`);
    edit.addEventListener('click',()=>openEditor(doc.file));toggle.addEventListener('click',()=>toggleDocument(doc));actions.append(edit,toggle);row.append(button,actions);$('documents').append(row);
  }
}
function nextVersion(version) {
  const match=version.match(/^(.*?)(\d+)$/);return match?match[1]+(Number(match[2])+1):version+'.1';
}
async function openEditor(file) {
  if(working)return;
  error('');editorError('');
  try {
    const doc=file?await api(`/api/document?file=${encodeURIComponent(file)}`):null;editorDocument=doc;
    $('editor-heading').textContent=doc?'编辑资料':'新建资料';$('editor-title').value=doc?.title??'';$('editor-version').value=doc?nextVersion(doc.version):'1.0';$('editor-text').value=doc?.text??'';$('import-document').value='';
    $('editor-note').textContent=doc?`当前版本 ${doc.version}。保存时使用新版本号，旧内容会保存在本地备份中。${doc.status==='inactive'?'这份资料已停用，编辑后仍保持停用。':''}`:'粘贴正文或导入 Markdown / TXT 文件，保存后即可检索。';
    editorCount();$('editor-dialog').showModal();$('editor-title').focus();
  } catch(e){error(e.message);}
}
function editorCount(){$('editor-count').textContent=`${$('editor-text').value.length} / 500000`;}
async function saveDocument() {
  if(working)return;
  editorError('');error('');setWorking(true);$('save-document').textContent='正在保存与刷新…';
  try {
    const result=await api('/api/documents/save',{file:editorDocument?.file,revision:editorDocument?.revision,title:$('editor-title').value,version:$('editor-version').value,text:$('editor-text').value});
    $('editor-dialog').close();refreshMessage(result);await status();
  }catch(e){editorError(e.message);}
  finally{setWorking(false);$('save-document').textContent='保存并刷新检索';}
}
async function toggleDocument(doc) {
  if(working)return;
  error('');setWorking(true);maintenance('正在更新资料状态…');
  try {
    const fresh=await api(`/api/document?file=${encodeURIComponent(doc.file)}`);
    const result=await api('/api/documents/status',{file:doc.file,revision:fresh.revision,status:doc.status==='active'?'inactive':'active'});
    refreshMessage(result);if(result.indexReady)maintenance(doc.status==='active'?'资料已停用，后续检索不再引用。':'资料已恢复，已重新加入检索。');await status();
  }catch(e){error(e.message);maintenance('');}
  finally{setWorking(false);}
}
async function orders() {
  try{
    const data=await api('/api/orders');$('orders').replaceChildren();$('db-error').hidden=true;$('db-status').textContent='已连接';
    for(const order of data.orders){const row=make('tr'),cell=make('td'),button=make('button','order-link',order.orderNo);button.type='button';button.addEventListener('click',()=>{$('question').value=`${order.orderNo} 还差多少？`;count();ask();});cell.append(button);row.append(cell,make('td','',order.item),make('td','',order.quantity),make('td','',order.received),make('td','',order.remaining));$('orders').append(row);}
  }catch(e){$('orders').replaceChildren();$('db-status').textContent='连接未成功';$('db-error').hidden=false;$('db-error').textContent=e.message;}
}
function count(){$('count').textContent=`${$('question').value.length} / 1000`;}
$('ask-form').addEventListener('submit',e=>{e.preventDefault();ask();});$('question').addEventListener('input',count);
for(const button of document.querySelectorAll('[data-question]'))button.addEventListener('click',()=>{$('question').value=button.dataset.question;count();$('question').focus();});
$('close-dialog').addEventListener('click',()=>$('document-dialog').close());
$('edit-viewed-document').addEventListener('click',()=>{$('document-dialog').close();openEditor(viewedFile);});
$('create-document').addEventListener('click',()=>openEditor());$('close-editor').addEventListener('click',()=>$('editor-dialog').close());
$('editor-dialog').addEventListener('cancel',e=>{if(working)e.preventDefault();});
$('document-form').addEventListener('submit',e=>{e.preventDefault();saveDocument();});$('editor-text').addEventListener('input',editorCount);
$('import-document').addEventListener('change',async()=>{
  const file=$('import-document').files[0];if(!file)return;editorError('');
  try {
    if(!/\.(md|txt)$/i.test(file.name)||file.size>2100000)throw new Error('请选择不超过 2 MB 的 Markdown 或 TXT 文件。');
    const text=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());
    if(!text.trim()||text.length>500000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))throw new Error('文件正文必须是有效文本，且不超过 50 万字符。');
    $('editor-text').value=text;if(!$('editor-title').value.trim())$('editor-title').value=file.name.replace(/\.(md|txt)$/i,'').slice(0,120);editorCount();
  }catch(e){editorError(e instanceof TypeError?'文件不是有效的 UTF-8 文本，请转换编码后再导入。':e.message);}
});
$('database-check').addEventListener('click',async()=>{const button=$('database-check');button.disabled=true;button.textContent='正在验证…';try{const r=await api('/api/database-check',{});$('db-status').textContent=`已连接 ${r.identity.databaseName}`;await orders();}catch(e){$('db-status').textContent='连接未成功';$('db-error').hidden=false;$('db-error').textContent=e.message;}finally{button.disabled=false;button.textContent='验证 SQL Server 连接';}});
$('rebuild').addEventListener('click',async()=>{if(working)return;error('');setWorking(true);$('rebuild').textContent='正在读取…';try{await api('/api/rebuild',{});await status();maintenance('资料已重新读取。');$('result').replaceChildren(make('p','fine','资料已重新读取。可以再次查询。'));}catch(e){error(e.message);}finally{setWorking(false);$('rebuild').textContent='重新读取资料';}});
Promise.all([status(),orders()]).catch(e=>error(e.message));
