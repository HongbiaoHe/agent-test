// 用法：node mix.mjs 无声画面.mp4 成片.mp4
// 旁白（vo/*.wav，按 plan.json 时间点）加一点空间 → 配乐在旁白下让位 → 叠音效 → 响度归一 → 与画面合流；顺带写出 stems/ 分轨供核对
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
const [video = "cine-silent.mp4", out = "canvas-agent-cinematic.mp4"] = process.argv.slice(2);
const plan = JSON.parse(readFileSync("plan.json", "utf8"));
const DUR = plan.duration, lines = plan.narration;
mkdirSync("stems", { recursive: true });
const inputs = ["-i", video, "-i", "music.wav", "-i", "sfx.wav", ...lines.flatMap((l) => ["-i", `vo/${l.id}.wav`])];
const graph = [
  ...lines.map((l, k) => { const ms = Math.round(l.at * 1000); return `[${k + 3}]adelay=${ms}|${ms},apad=whole_dur=${DUR}[v${k}]`; }),
  `${lines.map((_, k) => `[v${k}]`).join("")}amix=inputs=${lines.length}:normalize=0,highpass=f=90,` +
    `acompressor=threshold=0.1:ratio=3:attack=5:release=120,loudnorm=I=-16:TP=-2,aresample=48000,` +
    `aecho=0.85:0.5:70|140:0.16|0.08,aformat=channel_layouts=stereo,asplit=3[nar][key][narStem]`,
  `[1][key]sidechaincompress=threshold=0.05:ratio=3:attack=30:release=600,volume=0.85,asplit[m][musicStem]`,
  `[2]aecho=0.8:0.55:90|160:0.2|0.12,volume=0.95,asplit[s][sfxStem]`,
  // 整体抬约 3.8dB 到 ≈ −16 LUFS（网页播放的常用响度），不用 loudnorm：它会把静默与重击之间的落差压平
  `[m][s][nar]amix=inputs=3:normalize=0,volume=1.55,alimiter=limit=0.92,atrim=0:${DUR}[a]`,
].join(";");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...inputs, "-filter_complex", graph,
  "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", out,
  "-map", "[narStem]", "-ac", "1", "stems/nar.wav", "-map", "[musicStem]", "-ac", "1", "stems/music.wav", "-map", "[sfxStem]", "-ac", "1", "stems/sfx.wav"], { stdio: "inherit" });
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", out, "-ac", "1", "-ar", "48000", "stems/final.wav"], { stdio: "inherit" });
console.log("wrote", out);
