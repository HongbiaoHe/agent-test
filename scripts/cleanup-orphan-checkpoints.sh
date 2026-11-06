#!/usr/bin/env bash
# 清理 redis 里「MySQL 已经没有对应会话」的 LangGraph checkpoint 和会话事件流。
# thread_id = CanvasSession.id / Conversation.id（canvas.processor.ts / agent.processor.ts）。
# 默认只统计不删；加 --apply 才真删（UNLINK，后台释放内存）。
set -euo pipefail

REDIS=agent-test-redis-1
MYSQL=agent-test-mysql-1
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

docker exec "$MYSQL" mysql -uroot -pdev -N -e \
  "SELECT id FROM agent.CanvasSession UNION SELECT id FROM agent.Conversation UNION SELECT id FROM agent.DesignDoc" \
  2>/dev/null > "$TMP/live.txt"
[ -s "$TMP/live.txt" ] || { echo "MySQL 没查到任何会话，为安全起见中止"; exit 1; }

docker exec "$REDIS" redis-cli --scan --count 5000 > "$TMP/keys.txt"

# 只处理这四类前缀，且第二段（thread_id / 会话 id）不在 MySQL 里的
awk -F: 'NR==FNR{live[$1];next}
  ($1=="checkpoint"||$1=="checkpoint_write"||$1=="write_keys_zset"||$1=="conversation") && !($2 in live)' \
  "$TMP/live.txt" "$TMP/keys.txt" > "$TMP/orphan.txt"

echo "live 会话: $(wc -l < "$TMP/live.txt" | tr -d ' ')"
echo "redis key 总数: $(wc -l < "$TMP/keys.txt" | tr -d ' ')"
echo "待删孤儿 key: $(wc -l < "$TMP/orphan.txt" | tr -d ' ')（涉及 $(cut -d: -f2 "$TMP/orphan.txt" | sort -u | wc -l | tr -d ' ') 个会话）"
cut -d: -f1 "$TMP/orphan.txt" | sort | uniq -c

if [ "${1:-}" != "--apply" ]; then
  echo "（预览模式，未删除；确认后加 --apply 执行）"
  exit 0
fi

echo "used_memory 删前: $(docker exec "$REDIS" redis-cli info memory | grep '^used_memory_human' | cut -d: -f2)"

# 删除期间关掉自动落盘：大批量删除会触发 BGSAVE fork，数据集 ~6G 时写时复制会把
# 8G 的 Docker VM 撑爆（2026-11-06 第一次 --apply 就是这样被 OOM 打断、改动全丢）。
SAVE_CONF=$(docker exec "$REDIS" redis-cli config get save | sed -n 2p)
docker exec "$REDIS" redis-cli config set save "" > /dev/null
restore_save() { docker exec "$REDIS" redis-cli config set save "$SAVE_CONF" > /dev/null; }
trap 'restore_save; rm -rf "$TMP"' EXIT

# 每 500 个 key 一条 UNLINK，核对实际删掉的数量
awk '{printf "\"%s\" ", $0} NR%500==0{print ""} END{print ""}' "$TMP/orphan.txt" \
  | sed '/^$/d; s/^/UNLINK /' \
  | docker exec -i "$REDIS" redis-cli > "$TMP/unlink.out"
echo "UNLINK 实际删除: $(awk '{s+=$1} END{print s+0}' "$TMP/unlink.out") / 计划 $(wc -l < "$TMP/orphan.txt" | tr -d ' ')"
echo "dbsize 删后: $(docker exec "$REDIS" redis-cli dbsize)"
echo "used_memory 删后: $(docker exec "$REDIS" redis-cli info memory | grep '^used_memory_human' | cut -d: -f2)"

# 前台 SAVE 不 fork，不额外占内存；会阻塞 redis 几十秒
echo "落盘中（SAVE）..."
docker exec "$REDIS" redis-cli save
echo "自动落盘配置已恢复为: $SAVE_CONF"
