// 用法：node mix.mjs 无声画面.mp4 成片.mp4
// 旁白（say / 婷婷）按 vo/lines.json 的时间点摆好 → 配乐在旁白下自动压低 → 叠音效 → 响度归一 → 与画面合流
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";

const [video = "canvas-agent-intro-silent.mp4", out = "canvas-agent-intro.mp4"] = process.argv.slice(2);
const lines = JSON.parse(readFileSync("vo/lines.json", "utf8"));
const DUR = JSON.parse(readFileSync("plan.json", "utf8")).duration;
mkdirSync("stems", { recursive: true });
const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" });

// 1) 逐句配音：say → 去首尾静音 → 48k 单声道
for (const l of lines) {
  run("say", ["-v", "Tingting", "-r", String(l.rate), "-o", `vo/${l.id}.aiff`, l.text]);
  run("ffmpeg", ["-y", "-loglevel", "error", "-i", `vo/${l.id}.aiff`, "-af",
    "silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse",
    "-ar", "48000", "-ac", "1", `vo/${l.id}.wav`]);
}

// 2) 混音
const inputs = ["-i", video, "-i", "music.wav", "-i", "sfx.wav", ...lines.flatMap((l) => ["-i", `vo/${l.id}.wav`])];
const vo = lines.map((l, k) => {
  const ms = Math.round(l.at * 1000);
  return `[${k + 3}]adelay=${ms}|${ms},apad=whole_dur=${DUR}[v${k}]`;
});
const graph = [
  ...vo,
  `${lines.map((_, k) => `[v${k}]`).join("")}amix=inputs=${lines.length}:normalize=0,highpass=f=90,` +
    `acompressor=threshold=0.1:ratio=3:attack=5:release=120,loudnorm=I=-16:TP=-2,aresample=48000,aformat=channel_layouts=stereo,asplit=3[nar][key][narStem]`,
  // 旁白一响，配乐让位（实测见 analyze.mjs）；音效加一点空间感
  `[1][key]sidechaincompress=threshold=0.05:ratio=3:attack=30:release=600[mduck]`,
  `[2]aecho=0.8:0.5:110|170:0.22|0.14[sfx]`,
  `[mduck]volume=0.8,asplit[m][musicStem]`,
  `[sfx]volume=0.9,asplit[s][sfxStem]`,
  `[m][s][nar]amix=inputs=3:normalize=0,alimiter=limit=0.9,atrim=0:${DUR}[a]`,
].join(";");
run("ffmpeg", ["-y", "-loglevel", "error", ...inputs, "-filter_complex", graph,
  "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", out,
  // 分轨只用于核对（旁白位置 / 配乐让位 / 音效对拍），不进成片
  "-map", "[narStem]", "-ac", "1", "stems/nar.wav", "-map", "[musicStem]", "-ac", "1", "stems/music.wav", "-map", "[sfxStem]", "-ac", "1", "stems/sfx.wav"]);
console.log("wrote", out);
