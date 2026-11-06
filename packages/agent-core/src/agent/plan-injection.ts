/**
 * 「引用文件必读」硬规则（杠杆3，纯逻辑，刻意不依赖 langchain/deepagents，便于在 jest 里单测）。
 * SKILL.md 只是入口索引——它正文引用到的 references/*.md、子技能链接、模板/词库等资产，凡产出
 * 依赖其内容的结果之前都必须先 read_file 读取，禁止凭摘要臆造。
 *
 * 这条规则在平台片段 platform.skill_loading 里已有较详版本，但模式正文在中间件链最外层 = 最早注入，
 * 被后续一堆中间件提示（todo/skills/fs/...）挤到很靠前的位置，弱模型读到生成位置时已"忘了"。
 * 这里以 recency 最强的末尾位置再钉一遍，专治"读了 SKILL.md 就凭摘要硬答、不下钻 references"。
 *
 * 「当前任务计划」的注入已改走 modes/dynamic-context.ts 的 activePlanProvider。
 */
export const SKILL_READ_POLICY =
  `重要 · 引用文件必读（progressive disclosure 硬规则）：当前会话可能已激活某个技能。SKILL.md 只是入口索引——` +
  `它正文中引用到的文件（\`references/*.md\`、子技能(sub-skill)的 markdown 链接、模板/词库/示例等资产），` +
  `凡产出任何依赖其内容的结果之前，必须先用 \`read_file\` 读取对应文件并按其指示执行；尤其被标注为` +
  `「阶段前置/强制/必须先 read_file」的引用，未成功读取前禁止产出对应阶段的内容。` +
  `不要凭 SKILL.md 里的摘要或先验臆造这些被引用文件的内容。遵循按需加载：只读当前这一步真正需要的引用文件，` +
  `但绝不跳过被要求前置读取的文件。`;

/**
 * 始终把「引用文件必读」规则 concat 到 systemMessage 末尾（由 skillReadPolicyMiddleware 承载）。
 * 静态规则，与会话无关，故无条件注入。
 */
export function injectSkillReadPolicy(
  request: { systemMessage: { concat: (s: string) => unknown } },
  handler: (req: unknown) => unknown,
): unknown {
  return handler({
    ...request,
    systemMessage: request.systemMessage.concat(`\n\n${SKILL_READ_POLICY}`),
  });
}
