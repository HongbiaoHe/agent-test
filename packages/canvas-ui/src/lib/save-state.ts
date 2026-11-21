/** update_node 保存状态（按 nodeId）：saving 在途 / saved 刚成功 / error 失败已重拉快照 */
export type SaveState = "saving" | "saved" | "error";
