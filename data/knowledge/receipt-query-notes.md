# 收货查询说明（本人学习笔记）

依据：Inventory-demo 项目 `04_queries.sql` 的“查询3：收货跟踪表（订购、实收）”。

资料版本：1.1；核对日期：2026-10-11。

## 为什么收货跟踪使用 LEFT JOIN？

使用 LEFT JOIN 可以保留尚未到货的订购行。即使订单明细没有对应的入库记录，也要显示这条订购明细，才能跟踪未到货情况。如果改用 INNER JOIN，只会保留匹配成功的行，未匹配的订购行会被排除。

## 为什么实收数量使用 ISNULL(SUM(id.Quantity), 0)？

ISNULL 把实收数量的空结果转成 0。没有匹配的入库明细时，SUM(id.Quantity) 得到的是 NULL，外层的 ISNULL(..., 0) 才将它变成 0。待收数量的计算是订购数量 od.Quantity 减去实收数量；GoodsId 是商品编号，不是数量。

## 为什么匹配入库明细时还需要 GoodsId？

GoodsId 确保订购商品与入库商品对应。一张入库单可能有多种商品，只按入库单编号连接会把其他商品的入库数量也算进来，因此还要匹配商品编号。条件 id.GoodsId = od.GoodsId 使订购行只匹配同一种商品的入库明细。

## 分批入库的数量如何累计？

同一订单的同一种商品可以分多次入库。查询3通过 SUM(id.Quantity) 累计匹配到的入库明细数量，再用订购数量减去累计实收数量，得到待收数量。

假设该订单中这个商品只有一条订购明细，订购 10 件；两张对应入库单分别收到 4 件和 3 件。那么实收数量为 4 + 3 = 7 件，待收数量为 10 - 7 = 3 件。连接时仍需按来源订单和 GoodsId 限定匹配范围，避免混入其他商品的数量。

这是解释原 SQL 的假设示例，不是数据库中的实时订单数据。该查询未筛选入库单状态，示例也不代表新增了审核规则；同一订单同一商品重复订购明细的统计限制仍然存在。

## 原查询中的相关 SQL

以下是现有查询的摘录，用来说明连接与数量计算的依据。

```sql
isnull(sum(id.Quantity), 0) as 实收数量,
od.Quantity - isnull(sum(id.Quantity), 0) as 待收数量

from dbo.PurchaseOrderDetail od
inner join dbo.PurchaseOrder po on po.OrderId = od.OrderId
inner join dbo.Goods g on g.GoodsId = od.GoodsId
left join dbo.PurchaseIn pi on pi.OrderId = od.OrderId
left join dbo.PurchaseInDetail id
  on id.PurchaseInId = pi.PurchaseInId and id.GoodsId = od.GoodsId
```

## 现有查询的边界

该查询没有筛选入库单状态。同一订单同一商品存在重复订购明细时，现有连接与聚合仍有统计限制；GoodsId 匹配条件不会消除重复明细。这份笔记只解释现有收货查询，不代表已经修正这些限制，也不代表新增审核、自动过账或库存管理功能。
