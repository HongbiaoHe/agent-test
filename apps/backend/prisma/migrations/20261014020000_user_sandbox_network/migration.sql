-- 用户级沙箱网络设置；NULL = 默认（出站开放、端口公网地址需鉴权）。
ALTER TABLE `User` ADD COLUMN `sandboxNetworkMode` VARCHAR(191) NULL,
    ADD COLUMN `sandboxNetworkAllowList` JSON NULL,
    ADD COLUMN `sandboxPublicTraffic` BOOLEAN NULL;
