import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

const hash = text=>createHash('sha256').update(text).digest('hex');
const stop=new Set(['什么','怎么','如何','可以','需要','请问','这个','那个','我的','我们','是否','哪些','多少','一下','怎样','应该','的是']);
export function tokenize(text) {
  const tokens=[];
  for (const part of text.normalize('NFKC').toLowerCase().match(/[\p{Script=Han}]+|[a-z0-9]+/gu)??[]) {
    if (/^[a-z0-9]+$/.test(part)) {tokens.push(part);continue;}
    for(let i=0;i<part.length-1;i++) {const t=part.slice(i,i+2);if(!stop.has(t)) tokens.push(t);}
  }
  return tokens;
}
export function chunkDocument(text, meta, maxLength=550, overlap=80) {
  const lines=text.replace(/\r\n/g,'\n').split('\n');
  const sections=[];let current={section:meta.title,start:1,lines:[]};
  for(let i=0;i<lines.length;i++) {
    if (/^#{1,6}\s/.test(lines[i])) {
      if(current.lines.some(x=>x.trim())) sections.push(current);
      current={section:lines[i].replace(/^#+\s*/,''),start:i+1,lines:[lines[i]]};
    } else current.lines.push(lines[i]);
  }
  if(current.lines.some(x=>x.trim())) sections.push(current);
  const chunks=[];
  for(const section of sections) {
    const joined=section.lines.join('\n');
    for(let offset=0;offset<joined.length;) {
      const end=Math.min(offset+maxLength,joined.length);
      const content=joined.slice(offset,end);
      if(content.trim()) {
        const startLine=section.start+(joined.slice(0,offset).match(/\n/g)??[]).length;
        const endLine=section.start+(joined.slice(0,end).match(/\n/g)??[]).length;
        chunks.push({...meta,id:hash(`${meta.file}|${meta.version}|${section.section}|${offset}|${content}`).slice(0,20),section:section.section,text:content,lineStart:startLine,lineEnd:endLine});
      }
      if(end===joined.length) break;
      offset=end-overlap;
    }
  }
  return chunks;
}
export function loadCorpus(root) {
  const manifest=JSON.parse(readFileSync(resolve(root,'data/manifest.json'),'utf8'));
  const base=resolve(root,'data/knowledge');
  const chunks=[];
  for(const meta of manifest) {
    if(meta.status!=='active') continue;
    if(typeof meta.file!=='string' || !/\.(md|txt)$/i.test(meta.file)) throw new Error('资料仅支持 Markdown 和 TXT。');
    const path=resolve(base,meta.file);
    if(!path.startsWith(base+sep)) throw new Error('资料路径必须位于 data/knowledge。');
    const text=readFileSync(path,'utf8');
    if(text.length>500000) throw new Error('单份资料超出本演示的 50 万字符限制。');
    chunks.push(...chunkDocument(text,meta));
  }
  if(!chunks.length) throw new Error('知识库没有有效资料。');
  return {manifest,chunks,fingerprint:hash(JSON.stringify(chunks))};
}
export function bm25(chunks, question) {
  const tokenLists=chunks.map(c=>tokenize(`${c.title} ${c.section} ${c.text}`));
  const df=new Map();
  for(const tokens of tokenLists) for(const token of new Set(tokens)) df.set(token,(df.get(token)??0)+1);
  const query=[...new Set(tokenize(question))];
  const avgLength=tokenLists.reduce((n,t)=>n+t.length,0)/tokenLists.length || 1;
  return tokenLists.map((tokens,index)=>{
    const freq=new Map();for(const t of tokens) freq.set(t,(freq.get(t)??0)+1);
    let score=0;let matched=0;
    for(const t of query) {
      const f=freq.get(t)??0;if(!f) continue;matched++;
      const idf=Math.log(1+(chunks.length-(df.get(t)??0)+0.5)/((df.get(t)??0)+0.5));
      score+=idf*f*2.2/(f+1.2*(0.25+0.75*tokens.length/avgLength));
    }
    return {index,lexical:score,coverage:matched/(query.length||1)};
  }).sort((a,b)=>b.lexical-a.lexical);
}
export function cosine(a,b) {
  if(a.length!==b.length) throw new Error('查询向量与资料向量维度不一致，请重建索引。');
  let dot=0,aa=0,bb=0;
  for(let i=0;i<a.length;i++){dot+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i];}
  return aa&&bb?dot/Math.sqrt(aa*bb):0;
}
export class KnowledgeIndex {
  constructor(root,config,provider) {this.root=root;this.config=config;this.provider=provider;this.corpus=loadCorpus(root);this.vectors=null;this.pending=null;}
  signature() {return hash(JSON.stringify({corpus:this.corpus.fingerprint,url:this.config.baseUrl,model:this.config.embedModel,format:1}));}
  async rebuild() {
    if(this.pending) return this.pending;
    this.pending=(async()=>{
      const nextCorpus=loadCorpus(this.root);
      // 按完整语料版本替换，避免已删除/停用资料残留。
      this.corpus=nextCorpus;this.vectors=null;
      if(this.config.mode!=='online') return;
      const cacheFile=resolve(this.root,'runtime/vectors.json');const signature=this.signature();
      if(existsSync(cacheFile)) {
        try {
          const cached=JSON.parse(readFileSync(cacheFile,'utf8'));
          if(cached.signature===signature && Array.isArray(cached.vectors) && cached.vectors.length===this.corpus.chunks.length && cached.vectors.every(v=>Array.isArray(v)&&v.length&&v.every(Number.isFinite)&&v.some(x=>x!==0)&&v.length===cached.vectors[0].length)) {
            this.vectors=cached.vectors;return;
          }
        } catch { /* 无效缓存将重建。 */ }
      }
      const texts=this.corpus.chunks.map(c=>`${c.title}\n${c.section}\n${c.text}`);
      const vectors=await this.provider.embed(texts);
      mkdirSync(resolve(this.root,'runtime'),{recursive:true});
      writeFileSync(cacheFile+'.tmp',JSON.stringify({signature,vectors}));renameSync(cacheFile+'.tmp',cacheFile);
      this.vectors=vectors;
    })();
    try {await this.pending;} finally {this.pending=null;}
  }
  async retrieve(question,topK=4) {
    // 每次检查语料版本，修改、停用、删除后不沿用旧索引。
    const fresh=loadCorpus(this.root);
    if(fresh.fingerprint!==this.corpus.fingerprint) {this.corpus=fresh;this.vectors=null;}
    if(this.config.mode==='online' && (!this.vectors || this.pending)) await this.rebuild();
    const chunks=this.corpus.chunks;
    const lexical=bm25(chunks,question);
    const lexicalCandidates=lexical.filter(r=>r.lexical>=1.1 && r.coverage>=0.16).slice(0,12);
    const scores=new Map();
    const add=(row,rank,type)=>{const r=scores.get(row.index)??{index:row.index,rrf:0};r.rrf+=1/(60+rank+1);Object.assign(r,type==='lexical'?{lexical:row.lexical,coverage:row.coverage}:{similarity:row.similarity});scores.set(row.index,r);};
    lexicalCandidates.forEach((r,i)=>add(r,i,'lexical'));
    if(this.config.mode==='online') {
      const [queryVector]=await this.provider.embed([question]);
      const vector=chunks.map((c,index)=>({index,similarity:cosine(queryVector,this.vectors[index])})).filter(r=>r.similarity>=this.config.minSimilarity).sort((a,b)=>b.similarity-a.similarity).slice(0,12);
      vector.forEach((r,i)=>add(r,i,'vector'));
    }
    return [...scores.values()].sort((a,b)=>b.rrf-a.rrf||(b.lexical??0)-(a.lexical??0)).slice(0,topK).map((r,i)=>({...chunks[r.index],citation:`K${i+1}`,scores:{rrf:r.rrf,lexical:r.lexical??0,similarity:r.similarity??null}}));
  }
}
