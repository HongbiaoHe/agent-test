-- 用户级沙箱提供方偏好（daytona | e2b）；NULL = 跟随 env SANDBOX_PROVIDER。
ALTER TABLE `User` ADD COLUMN `sandboxProvider` VARCHAR(191) NULL;
