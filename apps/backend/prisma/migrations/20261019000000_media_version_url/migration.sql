-- aigc 产物改存 CDN 地址（不再转存到本地 data/media）
ALTER TABLE `MediaVersion` ADD COLUMN `url` TEXT NULL;
