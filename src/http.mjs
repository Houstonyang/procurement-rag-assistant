import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ProcurementAssistant } from './assistant.mjs';
import { KnowledgeDocuments } from './documents.mjs';

const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
async function body(req,limit=8192) {
  if(!req.headers['content-type']?.startsWith('application/json')) throw new Error('请求必须使用 application/json。');
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>limit)throw new Error('请求内容过大。');chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('请求不是有效 JSON。');}
}
export function createAppServer(root,config,providedAssistant) {
  const assistant=providedAssistant??new ProcurementAssistant(root,config);let busy=false;
  const documents=new KnowledgeDocuments(root);
  const server=createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const port=server.address()?.port;
    if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host))return send(res,403,{error:'仅支持本机访问。'});
    if(req.headers.origin&&!['http://127.0.0.1:'+port,'http://localhost:'+port].includes(req.headers.origin))return send(res,403,{error:'来源不匹配。'});
    let url;try{url=new URL(req.url,`http://127.0.0.1:${port}`);}catch{return send(res,400,{error:'请求地址无效。'});}
    try {
      if(req.method==='GET'&&url.pathname==='/api/status')return send(res,200,{...assistant.status(),busy});
      if(req.method==='GET'&&url.pathname==='/api/orders')return send(res,200,{orders:await assistant.orders.all(),databaseDriver:'sqlserver'});
      if(req.method==='POST'&&url.pathname==='/api/database-check'){await body(req);return send(res,200,await assistant.orders.probe());}
      if(req.method==='GET'&&url.pathname==='/api/document'){
        return send(res,200,documents.get(url.searchParams.get('file')));
      }
      if(req.method==='POST'&&['/api/ask','/api/rebuild','/api/documents/save','/api/documents/status'].includes(url.pathname)){
        const editing=url.pathname.startsWith('/api/documents/');
        const data=await body(req,editing?2100000:8192);
        if(busy)return send(res,409,{error:'正在处理一个请求，请等待完成后再试。'});
        busy=true;
        try{
          if(editing){
            const document=url.pathname.endsWith('/save')?documents.save(data):documents.setStatus(data);
            try { await assistant.index.rebuild(); }
            catch(error) { return send(res,200,{saved:true,indexReady:false,document,warning:'资料已保存，但重新读取未完成：'+error.message,...assistant.status()}); }
            return send(res,200,{saved:true,indexReady:true,document,...assistant.status()});
          }
          if(url.pathname==='/api/rebuild'){await assistant.index.rebuild();return send(res,200,assistant.status());}
          return send(res,200,await assistant.ask(data?.question));
        }finally{busy=false;}
      }
      const assets={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css']};
      if(req.method==='GET'&&Object.hasOwn(assets,url.pathname)){
        const [file,type]=assets[url.pathname];res.writeHead(200,{'Content-Type':`${type}; charset=utf-8`,'Cache-Control':'no-cache'});res.end(readFileSync(resolve(root,'public',file)));return;
      }
      return send(res,404,{error:'没有这个页面或接口。'});
    }catch(error){send(res,error.status??400,{error:error.message});}
  });
  server.requestTimeout=30000;
  return {server,assistant};
}
