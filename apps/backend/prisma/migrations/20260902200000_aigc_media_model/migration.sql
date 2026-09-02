-- 媒体生成改走 aigc 服务：版本记录下渠道 / 档位参数 / aigc task_id（回调按它反查版本）。
-- 历史行留 NULL：那些版本是直连 Google 生成的，没有渠道与档位概念。
ALTER TABLE `MediaVersion` ADD COLUMN `channel` VARCHAR(191) NULL;
ALTER TABLE `MediaVersion` ADD COLUMN `params` JSON NULL;
ALTER TABLE `MediaVersion` ADD COLUMN `providerTaskId` VARCHAR(191) NULL;
CREATE INDEX `MediaVersion_providerTaskId_idx` ON `MediaVersion`(`providerTaskId`);

-- 生成节点选定的模型与档位（空 = 用该类型默认模型）。
ALTER TABLE `CanvasNode` ADD COLUMN `mediaChannel` VARCHAR(191) NULL;
ALTER TABLE `CanvasNode` ADD COLUMN `mediaModel` VARCHAR(191) NULL;
ALTER TABLE `CanvasNode` ADD COLUMN `mediaParams` JSON NULL;
