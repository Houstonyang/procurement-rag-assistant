import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync, lstatSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const fail = (message, status=400) => { throw Object.assign(new Error(message), {status}); };
const revision = (meta, text) => createHash('sha256').update(JSON.stringify(meta)+'\n'+text).digest('hex');

export class KnowledgeDocuments {
  constructor(root) {
    this.root=root;
    this.base=resolve(root,'data/knowledge');
    this.manifestFile=resolve(root,'data/manifest.json');
  }
  manifest() { return JSON.parse(readFileSync(this.manifestFile,'utf8')); }
  path(file) {
    if(typeof file!=='string' || !/^[a-z0-9][a-z0-9._-]{0,79}\.(md|txt)$/i.test(file) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(file)) fail('资料文件名无效，仅支持普通 Markdown 或 TXT 文件。');
    const path=resolve(this.base,file);
    if(!path.startsWith(this.base+sep)) fail('资料路径无效。');
    if(existsSync(path)) {
      const stat=lstatSync(path);
      if(!stat.isFile() || stat.isSymbolicLink()) fail('资料必须是知识目录中的普通文件。');
    }
    return path;
  }
  get(file) {
    const meta=this.manifest().find(d=>d.file===file);
    if(!meta) fail('资料不存在。',404);
    const text=readFileSync(this.path(file),'utf8');
    return {...meta,text,revision:revision(meta,text)};
  }
  validate(data) {
    if(!data || typeof data!=='object' || Array.isArray(data)) fail('资料内容无效。');
    for(const [key,label,max] of [['title','标题',120],['version','版本',80]]) {
      if(typeof data[key]!=='string' || !data[key].trim() || data[key].length>max || /[\x00-\x1f\x7f]/.test(data[key])) fail(`${label}不能为空，且最多 ${max} 个字符。`);
    }
    if(typeof data.text!=='string' || !data.text.trim() || data.text.length>500000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(data.text)) fail('正文不能为空，仅支持文本，最多 50 万字符。');
  }
  backup(manifest,document) {
    const dir=resolve(this.root,'runtime/document-history');
    mkdirSync(dir,{recursive:true});
    writeFileSync(resolve(dir,randomUUID()+'.json'),JSON.stringify({savedAt:new Date().toISOString(),manifest,document},null,2),'utf8');
  }
  writeManifest(manifest) {
    const temp=this.manifestFile+'.'+randomUUID()+'.tmp';
    try { writeFileSync(temp,JSON.stringify(manifest,null,2)+'\n','utf8'); renameSync(temp,this.manifestFile); }
    finally { if(existsSync(temp)) unlinkSync(temp); }
  }
  save(data) {
    this.validate(data);
    const manifest=this.manifest();
    const file=data.file || 'note-'+randomUUID().slice(0,8)+'.md';
    const path=this.path(file);
    const existing=manifest.find(d=>d.file.toLowerCase()===file.toLowerCase());
    let previous=null;
    if(existing) {
      previous=this.get(existing.file);
      if(file!==existing.file || !data.revision || data.revision!==previous.revision) fail('资料已被修改，或缺少当前版本。请重新打开后再编辑。',409);
      if(data.version.trim()===existing.version) fail('修改资料时请使用新版本号。');
    } else {
      if(data.revision) fail('资料不存在，请重新打开。',409);
      if(existsSync(path)) fail('这个文件已存在但未登记，请换一个文件名。',409);
    }
    const meta={...existing,file,title:data.title.trim(),version:data.version.trim(),status:existing?.status??'active',updatedAt:new Date().toISOString()};
    const next=existing?manifest.map(d=>d.file===existing.file?meta:d):[...manifest,meta];
    this.backup(manifest,previous);
    const temp=path+'.'+randomUUID()+'.tmp';
    try {
      writeFileSync(temp,data.text,'utf8'); renameSync(temp,path);
      try { this.writeManifest(next); }
      catch(error) { if(previous) writeFileSync(path,previous.text,'utf8'); else unlinkSync(path); throw error; }
    } finally { if(existsSync(temp)) unlinkSync(temp); }
    return this.get(file);
  }
  setStatus(data) {
    if(!data || !['active','inactive'].includes(data.status)) fail('资料状态只能为有效或停用。');
    const previous=this.get(data.file);
    if(!data.revision || data.revision!==previous.revision) fail('资料已被修改，请重新打开后再操作。',409);
    const manifest=this.manifest();
    if(data.status==='inactive' && previous.status==='active' && manifest.filter(d=>d.status==='active').length<=1) fail('至少保留一份有效资料；请先新增资料再停用。');
    if(previous.status===data.status) return previous;
    this.backup(manifest,previous);
    this.writeManifest(manifest.map(d=>d.file===data.file?{...d,status:data.status,updatedAt:new Date().toISOString()}:d));
    return this.get(data.file);
  }
}
