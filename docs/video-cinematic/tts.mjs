// 用法：node tts.mjs plan.json → vo/<id>.wav（婷婷，去首尾静音，48k 单声道）+ vo/durations.json
// 并检查每句是否在下一句开始前 0.25s 说完（片尾一句要在全片结束前 1s 说完）
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const plan = JSON.parse(readFileSync(process.argv[2] ?? "plan.json", "utf8"));
const RATE = 165; // 比日常语速慢一档：预告片的旁白要有留白
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"] }).toString();
const dur = {};
let bad = 0;
plan.narration.forEach((l, k) => {
  run("say", ["-v", "Tingting", "-r", String(RATE), "-o", `vo/${l.id}.aiff`, l.text]);
  run("ffmpeg", ["-y", "-loglevel", "error", "-i", `vo/${l.id}.aiff`, "-af",
    "silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse",
    "-ar", "48000", "-ac", "1", `vo/${l.id}.wav`]);
  dur[l.id] = +(+run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", `vo/${l.id}.wav`])).toFixed(3);
  const limit = k < plan.narration.length - 1 ? plan.narration[k + 1].at - 0.25 : plan.duration - 1;
  const end = l.at + dur[l.id];
  const okay = end <= limit;
  if (!okay) bad++;
  console.log(`${l.id} ${dur[l.id].toFixed(2)}s  ${l.at}→${end.toFixed(2)}  限 ${limit.toFixed(2)}  ${okay ? "ok" : "OVER"}  ${l.text}`);
});
writeFileSync("vo/durations.json", JSON.stringify(dur, null, 1));
if (bad) { console.error(`${bad} 句超时`); process.exit(1); }
