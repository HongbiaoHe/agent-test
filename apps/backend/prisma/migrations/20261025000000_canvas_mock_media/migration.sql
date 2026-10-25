-- 画布测试模式（Mock）：会话开关 + 生成版本的模拟标记（都默认 false，旧代码忽略这两列不受影响）
ALTER TABLE `CanvasSession` ADD COLUMN `mockMedia` BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE `MediaVersion` ADD COLUMN `mock` BOOLEAN NOT NULL DEFAULT false;
