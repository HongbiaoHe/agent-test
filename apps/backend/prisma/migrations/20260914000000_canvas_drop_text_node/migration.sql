-- 下线 text 提示词节点：提示词改由 image_gen / video_gen 自己的 prompt 字段承载。
--
-- 顺序是本文件的要害：**先把提示词搬进生成节点，再删列**。两步拆成两个文件/两条命令的话，
-- 只要有人先跑了 DROP，那批正文就再也找不回来了；放同一个迁移里，这个错误在构造上不可能发生。
--
-- 只写 prompt **为空** 的生成节点：已经有 prompt 的一律不碰（那批是 agent 写的改写版，
-- 虽然旧实现从不读它，但要不要用上游覆盖它是产品判断，不该由迁移替人做主）。
--
-- 刻意**不删** type='text' 的历史行：保留行本身，让老会话的节点 id / 连线记录仍可追溯；
-- 应用层已按 isCanvasNodeType 在快照里过滤掉它们，不会进接口，也不会渲染。

-- GROUP_CONCAT 默认上限 1024 字节，提示词轻易超过——不抬高会**静默截断**。
SET SESSION group_concat_max_len = 1048576;

-- ① 恰好一个非空 text 上游：原样搬过去（对应旧 joinPromptParts 的单条分支）
UPDATE `CanvasNode` g
JOIN (
  SELECT e.target AS gid, MIN(t.text) AS txt, COUNT(*) AS cnt
  FROM `CanvasEdge` e
  JOIN `CanvasNode` t
    ON t.id = e.source AND t.type = 'text' AND TRIM(COALESCE(t.text, '')) <> ''
  GROUP BY e.target
) u ON u.gid = g.id AND u.cnt = 1
SET g.prompt = u.txt
WHERE g.type IN ('image_gen', 'video_gen')
  AND TRIM(COALESCE(g.prompt, '')) = '';

-- ② 多个非空 text 上游：按**入边顺序**编号拼接，还原旧 joinPromptParts 的多条分支
--    （`1. …\n2. …`）。入边顺序 = CanvasEdge.createdAt 升序，与当初快照读边的顺序一致；
--    createdAt 撞毫秒时用 id 兜底，保证结果稳定可重放。
--    ① 已经把单上游的填掉了，这里的 TRIM(prompt)='' 因此只会命中多上游那批。
UPDATE `CanvasNode` g
JOIN (
  SELECT gid, GROUP_CONCAT(numbered ORDER BY rn SEPARATOR '\n') AS txt
  FROM (
    SELECT
      e.target AS gid,
      ROW_NUMBER() OVER (PARTITION BY e.target ORDER BY e.createdAt, e.id) AS rn,
      CONCAT(
        ROW_NUMBER() OVER (PARTITION BY e.target ORDER BY e.createdAt, e.id),
        '. ',
        t.text
      ) AS numbered
    FROM `CanvasEdge` e
    JOIN `CanvasNode` t
      ON t.id = e.source AND t.type = 'text' AND TRIM(COALESCE(t.text, '')) <> ''
  ) x
  GROUP BY gid
) u ON u.gid = g.id
SET g.prompt = u.txt
WHERE g.type IN ('image_gen', 'video_gen')
  AND TRIM(COALESCE(g.prompt, '')) = '';

-- ③ 正文已经搬走，列可以走了
ALTER TABLE `CanvasNode` DROP COLUMN `text`;
