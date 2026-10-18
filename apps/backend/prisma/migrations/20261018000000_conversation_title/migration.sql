-- 会话重命名：用户自定义标题（NULL = 未命名，界面回退显示 goal）
ALTER TABLE `Conversation` ADD COLUMN `title` VARCHAR(200) NULL;
