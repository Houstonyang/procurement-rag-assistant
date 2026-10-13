import { KnowledgeIndex } from './knowledge.mjs';
import { SqlServerStore,classify } from './orders.mjs';
import { ModelProvider } from './provider.mjs';
import { publicConfig } from './config.mjs';

const quantity=x=>Number(x).toLocaleString('zh-CN',{maximumFractionDigits:2});
export class ProcurementAssistant{
  constructor(root,config,provider=new ModelProvider(config),store=new SqlServerStore(root,config)){this.config=config;this.index=new KnowledgeIndex(root,config,provider);this.orders=store;this.provider=provider;}
  status(){return {...publicConfig(this.config),documents:this.index.corpus.manifest,chunkCount:this.index.corpus.chunks.length,vectorReady:Boolean(this.index.vectors),databaseVerified:Boolean(this.orders.lastProbe),scope:'Inventory-demo 已完成的采购查询'};}
  async ask(question){
    if(typeof question!=='string'||!question.trim()||question.length>1000)throw new Error('请输入 1–1000 个字符的问题。');
    question=question.trim();const start=performance.now(),plan=classify(question);
    const finish=r=>({...r,route:plan.route,mode:this.config.mode,durationMs:Math.round(performance.now()-start)});
    if(plan.route==='readonly')return finish({kind:'refused',answer:'接入层仅执行现有采购 SELECT 查询，不执行订单、入库单或表结构写入。',sources:[]});
    if(plan.route==='clarify'||plan.route==='unavailable')return finish({kind:plan.route==='clarify'?'clarify':'refused',answer:plan.message,sources:[]});
    const source=(section,data)=>[{citation:'D1',title:`SQL Server / ${this.config.sqlDatabase}`,section,version:'Inventory-demo 当前查询口径',text:JSON.stringify(data,null,2)}];
    if(plan.route==='order'){
      const record=await this.orders.get(plan.reference);
      if(!record)return finish({kind:'refused',answer:'Inventory 数据库中没有这个订单，不能推断其数量或状态。',sources:[]});
      const {header,lines}=record;const text=lines.map(r=>`${r.item}：订购 ${quantity(r.quantity)}，实际入库 ${quantity(r.received)}，待收 ${quantity(r.remaining)}。`).join('\n');
      return finish({kind:'sql',answer:`订单 ${header.orderNo}，单据状态 ${header.status}，下单日期 ${header.orderDate}。\n${text||'此订单没有明细，不能编造数量；现有三个明细查询不包含该订单。'}\n状态来自数据库，不代表已经实现自动审核或自动关闭。`,header,rows:lines,sources:source('订单表头及原收货跟踪口径',record)});
    }
    if(['tracking','details','suppliers'].includes(plan.route)){
      let rows,answer;
      if(plan.route==='tracking'){
        rows=await this.orders.all();if(plan.pendingOnly)rows=rows.filter(r=>r.remaining>0);if(plan.completeOnly)rows=rows.filter(r=>r.remaining===0);
        answer=`${plan.pendingOnly?'待收明细':'收货跟踪'} ${rows.length} 行：\n`+rows.map(r=>`${r.orderNo} / ${r.item}：订购 ${quantity(r.quantity)}，实收 ${quantity(r.received)}，待收 ${quantity(r.remaining)}。`).join('\n');
      }else if(plan.route==='details'){
        rows=await this.orders.details();answer=`采购明细 ${rows.length} 行：\n`+rows.map(r=>`${r.orderNo} / ${r.item}：数量 ${quantity(r.quantity)}，单价 ${Number(r.price).toFixed(2)}，金额 ${Number(r.amount).toFixed(2)}。`).join('\n');
      }else{
        rows=await this.orders.suppliers();answer=`供应商采购金额汇总 ${rows.length} 行：\n`+rows.map(r=>`${r.supplier}：${r.orderCount} 张订单，采购总金额 ${Number(r.totalAmount).toFixed(2)}。`).join('\n')+'\n金额来自订单明细，不是实际入库金额或付款金额；按原查询按供应商名称分组。';
      }
      return finish({kind:'sql',answer,rows,sources:source(plan.route,rows)});
    }
    const candidates=await this.index.retrieve(question);
    if(!candidates.length)return finish({kind:'refused',answer:'现有项目资料没有检索到足够相关的内容，请限定到已经完成的采购功能。',sources:[],candidates:[]});
    if(this.config.mode==='preview')return finish({kind:'preview',answer:'已找到 Inventory-demo 的相关资料。当前是检索预览，尚未调用大模型生成答案。',sources:candidates,candidates});
    const generated=await this.provider.generate(question,candidates);
    if(!generated.supported)return finish({kind:'refused',answer:generated.answer,sources:[],candidates});
    return finish({kind:'rag',answer:generated.answer,sources:candidates.filter(s=>generated.citations.includes(s.citation)),candidates});
  }
  close(){this.orders.close();}
}
