-- 模式引用模式作子 agent：用途说明 + 勾选的子 agent 模式 id（见 agent-core resolveMode）
ALTER TABLE `AgentMode` ADD COLUMN `description` VARCHAR(500) NULL;
ALTER TABLE `AgentMode` ADD COLUMN `subagentModeIds` JSON NULL;
UPDATE `AgentMode` SET `subagentModeIds` = JSON_ARRAY() WHERE `subagentModeIds` IS NULL;
ALTER TABLE `AgentMode` MODIFY `subagentModeIds` JSON NOT NULL;
