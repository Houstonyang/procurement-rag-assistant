import { readFileSync,writeFileSync,mkdirSync,existsSync } from 'node:fs';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.mjs';
import { SqlServerStore,runSqlcmd } from '../src/orders.mjs';
import { buildInventoryQuery } from '../src/inventory-sql.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const config=readConfig(root);
const report={date:new Date().toISOString(),driver:'SQL Server',auth:'Windows',configuredServer:config.sqlServer,database:config.sqlDatabase,windowsUser:`${process.env.USERDOMAIN||''}\\${process.env.USERNAME||''}`,connected:false,passed:false,attempts:[]};
console.log('SQL Server 连接验证 v5（只读）');
console.log(`Windows 账号：${report.windowsUser}`);
console.log(`数据库：${config.sqlDatabase}`);
// Only the exact local computer name from the screenshot gets a shared-memory attempt.
const local=process.env.COMPUTERNAME;
const candidates=local&&config.sqlServer.toUpperCase()===local.toUpperCase()?[`lpc:${config.sqlServer}`,config.sqlServer]:[config.sqlServer];
try{
  let connectionError;
  for(const server of candidates){
    console.log(`尝试：${server}`);
    try{
      const identity=await runSqlcmd({...config,sqlServer:server},buildInventoryQuery('identity'));
      if(identity.ok!==true||identity.identity?.databaseName!==config.sqlDatabase)throw new Error('返回的数据库与配置不一致。');
      report.attempts.push({server,connected:true});report.connected=true;report.identity=identity.identity;config.sqlServer=server;break;
    }catch(error){connectionError=error;report.attempts.push({server,connected:false,error:error.message,driverDetail:error.driverDetail});console.error(error.driverDetail||error.message);}
  }
  if(!report.connected)throw connectionError;
  console.log(`已真实连接：${report.identity.server} / ${report.identity.databaseName}`);
  if(config.sqlServer!==report.configuredServer){
    const envPath=resolve(root,'.env');
    let env=existsSync(envPath)?readFileSync(envPath,'utf8'):readFileSync(resolve(root,'.env.example'),'utf8');
    env=/^RAG_SQL_SERVER=.*$/m.test(env)?env.replace(/^RAG_SQL_SERVER=.*$/m,`RAG_SQL_SERVER=${config.sqlServer}`):env+`\nRAG_SQL_SERVER=${config.sqlServer}\n`;
    writeFileSync(envPath,env);console.log(`已保存可用连接方式到本地 .env：${config.sqlServer}。网页服务需要重启。`);
  }
  const store=new SqlServerStore(root,config);
  const before=await store.probe();report.counts=before.counts;
  const details=await store.details(),suppliers=await store.suppliers(),tracking=await store.all();
  report.results={details,suppliers,tracking};
  const order=await store.get({type:'number',value:'PO20260915001'});
  const draft=await store.get({type:'number',value:'PO20260920001'});
  const after=await store.probe();
  const expected={Goods:30,Supplier:30,Customer:30,Warehouse:10,PurchaseOrder:8,PurchaseOrderDetail:9,PurchaseIn:3,PurchaseInDetail:3};
  report.checks={countsMatchReadme:Object.entries(expected).every(([k,v])=>before.counts[k]===v),detailsNineRows:details.length===9,suppliersFourRows:suppliers.length===4,trackingNineRows:tracking.length===9,
    bearing500300200:order?.lines.some(r=>r.item==='精密轴承'&&r.quantity===500&&r.received===300&&r.remaining===200)??false,
    draftHasHeaderWithoutLines:draft?.header.status==='DRAFT'&&draft.lines.length===0,
    supplierAmounts:JSON.stringify(suppliers.map(s=>s.totalAmount))===JSON.stringify([19950,12500,8300,6540]),
    tableCountsUnchanged:JSON.stringify(before.counts)===JSON.stringify(after.counts)};
  report.passed=Object.values(report.checks).every(Boolean);report.results={details,suppliers,tracking,order,draft};
  for(const [name,pass] of Object.entries(report.checks))console.log(`${pass?'PASS':'FAIL'} ${name}`);
  if(!report.passed)console.log('连接已成功，但当前数据与 README 示例不完全一致。程序不会重建或修正数据。');
}catch(error){report.error=error.message;report.driverDetail=error.driverDetail;if(error.queryResult){report.queryResult=error.queryResult;console.error('实际返回：'+JSON.stringify(error.queryResult));}console.error(error.message);if(report.connected&&error.driverDetail)console.error(error.driverDetail);console.error('尚未完成实时查询验收。没有执行初始化脚本或返回模拟数据。');process.exitCode=1;}
mkdirSync(resolve(root,'reports'),{recursive:true});writeFileSync(resolve(root,'reports/sqlserver-verification.json'),JSON.stringify(report,null,2));
console.log('验收记录：reports/sqlserver-verification.json');
