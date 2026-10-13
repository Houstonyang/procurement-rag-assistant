import { execFile } from 'node:child_process';
import { buildInventoryQuery,parseSqlcmdJson } from './inventory-sql.mjs';

export class SqlServerStore {
  constructor(root,config,runner=runSqlcmd){this.root=root;this.config=config;this.runner=runner;this.lastProbe=null;}
  async run(operation,reference=null){
    const query=buildInventoryQuery(operation,reference);
    const r=await this.runner(this.config,query);
    if(!r||r.ok!==true)throw new Error(`SQL Server 查询失败${r?.code!==undefined?`（错误码 ${r.code}）`:''}。请确认实例、Inventory 数据库和当前 Windows 账号权限。`);
    if(['order','tracking','details','suppliers'].includes(operation)&&!Array.isArray(r.rows)){
      const error=new Error(`SQL Server ${operation} 查询未返回明细数组，请检查返回格式。`);error.queryResult=r;throw error;
    }
    return r;
  }
  async probe(){const r=await this.run('probe');this.lastProbe=r;return r;}
  async get(reference){const r=await this.run('order',reference);return r.header?{header:r.header,lines:r.rows}:null;}
  async all(){return (await this.run('tracking')).rows;}
  async details(){return (await this.run('details')).rows;}
  async suppliers(){return (await this.run('suppliers')).rows;}
  close(){}
}
export function runSqlcmd(config,query,execute=execFile){
  return new Promise((resolveResult,reject)=>{
    const binary=config.sqlcmdPath||'C:\\Program Files\\Microsoft SQL Server\\Client SDK\\ODBC\\170\\Tools\\Binn\\SQLCMD.EXE';
    execute(binary,['-S',config.sqlServer,'-E','-d',config.sqlDatabase,'-N','-C','-l','6','-t','15','-b','-r','1','-u','-w','65535','-y','0','-x','-X1','-Q',query],{windowsHide:true,encoding:'buffer',timeout:30000,maxBuffer:2097152},(error,stdout,stderr)=>{
      if(error){
        const detail=decodeDiagnostic(stderr?.length?stderr:stdout?.length?stdout:error.message).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').trim().slice(0,2400);
        const failure=new Error(error.code==='ENOENT'?'找不到 sqlcmd，请检查 RAG_SQLCMD_PATH。':'SQL Server 连接或查询失败。请查看验证窗口中的驱动错误。');
        failure.driverDetail=detail;failure.exitCode=error.code;reject(failure);return;
      }
      try{resolveResult(parseSqlcmdJson(decodeDiagnostic(stdout)));}catch{reject(new Error('SQL Server 返回的数据格式无效；请使用支持 FOR JSON 的 SQL Server 2016 或更新版本。'));}
    });
  });
}
function decodeDiagnostic(value){
  if(!Buffer.isBuffer(value))return String(value??'');
  if((value[0]===0xff&&value[1]===0xfe)||value.subarray(0,512).includes(0))return value.toString('utf16le').replace(/^\uFEFF/,'');
  try{return new TextDecoder('utf-8',{fatal:true}).decode(value);}catch{return new TextDecoder('gb18030').decode(value);}
}
export function classify(question){
  if(/\b(insert|update|delete|drop|alter|truncate|create|exec)\b|^(删除|删掉|修改|录入)|帮我.*(删除|修改|新增|关闭|审核)/i.test(question))return {route:'readonly'};
  const nos=[...new Set((question.match(/\bPO\d{11}\b/gi)??[]).map(s=>s.toUpperCase()))];
  if(nos.length)return nos.length===1?{route:'order',reference:{type:'number',value:nos[0]}}:{route:'clarify',message:'请每次查询一个采购订单号。'};
  const ids=[...question.matchAll(/订单(?:内部)?(?:ID|编号)?\s*[:：#]?\s*(\d{1,10})(?!\d)/gi)];
  if(ids.length)return ids.length===1?{route:'order',reference:{type:'id',value:Number(ids[0][1])}}:{route:'clarify',message:'请每次查询一个采购订单编号。'};
  if(/逾期|预计到货|交货日期/.test(question))return {route:'unavailable',message:'现有 PurchaseOrder 表只有下单日期，没有预计到货日期，不能据此判断逾期。本次接入保留原有表结构。'};
  if(/查询库存|库存余额|库存流水|库存预警|负库存|销售出库|销售订单/.test(question))return {route:'unavailable',message:'这项能力在 Inventory-demo README 中仍列为待实现，本次仅接入已经完成的采购查询。'};
  const explanation=/(限制|原理|逻辑|怎么|如何|为什么|口径)/.test(question);
  if(/供应商.*(汇总|采购金额|采购额|排名)|采购总金额/.test(question)&&!explanation)return {route:'suppliers'};
  if(/采购明细|订单明细清单|订单明细列表/.test(question)&&!explanation)return {route:'details'};
  if(/收货跟踪|待收.*清单|收齐.*清单|哪些.*(待收|未收货|到齐|收齐)|所有.*订单/.test(question)&&!explanation)return {route:'tracking',pendingOnly:/待收|未收货/.test(question),completeOnly:/哪些.*(到齐|收齐)|收齐.*清单/.test(question)};
  if(/订单.*(数量|实收|待收|还差|状态|收齐)/.test(question)&&!/(怎么|如何|规则|怎样|计算|流程)/.test(question))return {route:'clarify',message:'请提供采购业务单号，例如：PO20260915001 还差多少？也支持内部编号，例如订单3。'};
  return {route:'knowledge'};
}
