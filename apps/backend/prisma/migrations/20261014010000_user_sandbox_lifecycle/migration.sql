-- 用户级沙箱生命周期设置；NULL = 使用默认值（闲置 5 分钟停机 / 停机 10 分钟删除）。
ALTER TABLE `User` ADD COLUMN `sandboxIdleMinutes` INTEGER NULL,
    ADD COLUMN `sandboxAutoDeleteMinutes` INTEGER NULL;
