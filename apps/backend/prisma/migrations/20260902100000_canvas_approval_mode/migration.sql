-- 敏感操作审批模式：review(默认) | auto。空值按 review 处理，故不回填历史行。
ALTER TABLE `CanvasSession` ADD COLUMN `approvalMode` VARCHAR(191) NULL;
