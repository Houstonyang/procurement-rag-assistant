const tracking=`SELECT po.OrderId AS [id],po.OrderNo AS [orderNo],g.GoodsName AS [item],
od.Quantity AS [quantity],ISNULL(SUM(ind.Quantity),0) AS [received],
od.Quantity-ISNULL(SUM(ind.Quantity),0) AS [remaining]
FROM dbo.PurchaseOrderDetail od
JOIN dbo.PurchaseOrder po ON po.OrderId=od.OrderId
JOIN dbo.Goods g ON g.GoodsId=od.GoodsId
LEFT JOIN dbo.PurchaseIn pi ON pi.OrderId=od.OrderId
LEFT JOIN dbo.PurchaseInDetail ind ON ind.PurchaseInId=pi.PurchaseInId AND ind.GoodsId=od.GoodsId`;
const grouped=' GROUP BY po.OrderId,po.OrderNo,g.GoodsName,od.Quantity ORDER BY po.OrderNo,g.GoodsName';
const details=`SELECT po.OrderNo AS [orderNo],s.SupplierName AS [supplier],g.GoodsName AS [item],
pd.Quantity AS [quantity],pd.Price AS [price],pd.Amount AS [amount]
FROM dbo.PurchaseOrderDetail pd
JOIN dbo.PurchaseOrder po ON po.OrderId=pd.OrderId
JOIN dbo.Supplier s ON s.SupplierId=po.SupplierId
JOIN dbo.Goods g ON g.GoodsId=pd.GoodsId ORDER BY po.OrderNo,g.GoodsName`;
const suppliers=`SELECT s.SupplierName AS [supplier],COUNT(DISTINCT po.OrderId) AS [orderCount],SUM(pd.Amount) AS [totalAmount]
FROM dbo.PurchaseOrderDetail pd JOIN dbo.PurchaseOrder po ON po.OrderId=pd.OrderId
JOIN dbo.Supplier s ON s.SupplierId=po.SupplierId
GROUP BY s.SupplierName ORDER BY [totalAmount] DESC`;
export const existingQueries=Object.freeze({tracking:tracking+grouped,details,suppliers});
export function buildInventoryQuery(operation,reference){
  let envelope;
  if(operation==='identity'){
    envelope=`SELECT CAST(1 AS bit) AS [ok],JSON_QUERY((SELECT @@SERVERNAME AS [server],DB_NAME() AS [databaseName] FOR JSON PATH,WITHOUT_ARRAY_WRAPPER)) AS [identity] FOR JSON PATH,WITHOUT_ARRAY_WRAPPER`;
  }else if(operation==='probe'){
    const counts=['Goods','Supplier','Customer','Warehouse','PurchaseOrder','PurchaseOrderDetail','PurchaseIn','PurchaseInDetail'].map(t=>`(SELECT COUNT(*) FROM dbo.${t}) AS [${t}]`).join(',');
    envelope=`SELECT CAST(1 AS bit) AS [ok],
JSON_QUERY((SELECT @@SERVERNAME AS [server],DB_NAME() AS [databaseName] FOR JSON PATH,WITHOUT_ARRAY_WRAPPER)) AS [identity],
JSON_QUERY((SELECT ${counts} FOR JSON PATH,WITHOUT_ARRAY_WRAPPER)) AS [counts] FOR JSON PATH,WITHOUT_ARRAY_WRAPPER`;
  }else if(operation==='order'){
    let condition;
    if(reference?.type==='number'&&/^PO\d{11}$/.test(reference.value))condition=`po.OrderNo=N'${reference.value}'`;
    else if(reference?.type==='id'&&Number.isSafeInteger(reference.value)&&reference.value>0&&reference.value<=2147483647)condition=`po.OrderId=${reference.value}`;
    else throw new Error('订单编号格式无效。');
    // References pass a strict character/number allowlist before inclusion.
    const header=`SELECT po.OrderId AS [id],po.OrderNo AS [orderNo],po.Status AS [status],
po.OrderDate AS [orderDate],s.SupplierName AS [supplier] FROM dbo.PurchaseOrder po
JOIN dbo.Supplier s ON s.SupplierId=po.SupplierId WHERE ${condition}`;
    envelope=`SELECT CAST(1 AS bit) AS [ok],JSON_QUERY((${header} FOR JSON PATH,WITHOUT_ARRAY_WRAPPER)) AS [header],
JSON_QUERY(COALESCE(NULLIF((${tracking} WHERE ${condition}${grouped} FOR JSON PATH),N''),N'[]')) AS [rows] FOR JSON PATH,WITHOUT_ARRAY_WRAPPER`;
  }else{
    const query=existingQueries[operation];
    if(!query)throw new Error('不支持的数据库操作。');
    envelope=`SELECT CAST(1 AS bit) AS [ok],JSON_QUERY(COALESCE(NULLIF((${query} FOR JSON PATH),N''),N'[]')) AS [rows] FOR JSON PATH,WITHOUT_ARRAY_WRAPPER`;
  }
  return `SET NOCOUNT ON; SELECT N'RAGJSON_START'+(${envelope})+N'RAGJSON_END' AS [payload];`;
}
export function parseSqlcmdJson(stdout){
  const start=stdout.indexOf('RAGJSON_START'),end=stdout.lastIndexOf('RAGJSON_END');
  if(start<0||end<start)throw new Error('SQL Server 没有返回完整的数据标记。');
  // sqlcmd may wrap NVARCHAR output; JSON strings escape their own line breaks.
  return JSON.parse(stdout.slice(start+13,end).replace(/\r?\n/g,''));
}
