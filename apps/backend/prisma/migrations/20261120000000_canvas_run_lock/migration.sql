-- desktop 本机 agent 改画布时的运行锁（持锁方 / 说明 / 到期时刻），见 @agent-test/canvas-schema lock.ts
ALTER TABLE `CanvasSession` ADD COLUMN `runLockHolder` VARCHAR(64) NULL;
ALTER TABLE `CanvasSession` ADD COLUMN `runLockLabel` VARCHAR(200) NULL;
ALTER TABLE `CanvasSession` ADD COLUMN `runLockExpiresAt` DATETIME(3) NULL;
