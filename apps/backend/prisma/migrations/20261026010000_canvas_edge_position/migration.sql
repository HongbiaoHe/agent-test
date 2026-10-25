-- 画布连线顺序显式化：同一终点的入边序号（拼接顺序 / 参考素材编号），不再隐式依赖创建时间
ALTER TABLE `CanvasEdge` ADD COLUMN `position` INTEGER NOT NULL DEFAULT 0;

-- 回填：每个终点的入边按原来的创建时间编号，现有画布的顺序保持不变
UPDATE `CanvasEdge` e
JOIN (
  SELECT `id`,
         ROW_NUMBER() OVER (PARTITION BY `sessionId`, `target` ORDER BY `createdAt`, `id`) - 1 AS `pos`
  FROM `CanvasEdge`
) r ON r.`id` = e.`id`
SET e.`position` = r.`pos`;
