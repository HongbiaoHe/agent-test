// 用法：node analyze.mjs  → 核对旁白落点 / 配乐让位 / 峰值 / 像素音对拍（读 stems/）
import { readFileSync } from "node:fs";
const read = (p) => { const b = readFileSync(p); const d = b.indexOf("data") + 8; const n = (b.length - d) / 2; const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = b.readInt16LE(d + i * 2) / 32768; return a; };
const SR = 48000;
const rms = (a, t0, t1) => { let s = 0, n = 0; for (let i = Math.floor(t0 * SR); i < Math.floor(t1 * SR); i++) { s += a[i] * a[i]; n++; } return (10 * Math.log10(s / n + 1e-12)).toFixed(1); };
const nar = read("stems/nar.wav"), mus = read("stems/music.wav"), fin = read("stems/final.wav"), sfx = read("stems/sfx.wav");
const lines = JSON.parse(readFileSync("vo/lines.json", "utf8"));
console.log("== 旁白是否落在字幕窗口内（旁白轨 >-45dB 的起止） ==");
for (const l of lines) {
  // 起点：只在设定时刻附近找旁白轨第一次出声；止点：起点 + 这一句自己的音频时长
  // 从上一句结束之后才开始找，免得把上一句的尾巴当成这一句的开头
  const k = lines.indexOf(l);
  const prevEnd = k > 0 ? lines[k - 1].at + read(`vo/${lines[k - 1].id}.wav`).length / SR : 0;
  let on = -1;
  for (let t = Math.max(l.at - 0.3, prevEnd + 0.02); t < l.at + 0.5 && on < 0; t += 0.01) if (+rms(nar, t, t + 0.02) > -45) on = t;
  const off = on + read(`vo/${l.id}.wav`).length / SR;
  console.log(l.id, `声音 ${on.toFixed(2)}–${off.toFixed(2)}s`, `窗口 ${l.at}–${l.end}s`, on >= l.at - 0.05 && off <= l.end + 0.05 ? "ok" : "OUT");
}
console.log("== 配乐 duck：每句旁白中段 vs 紧接着的间隙（≥0.8s）（dB RMS） ==");
for (let k = 0; k < lines.length - 1; k++) {
  const l = lines[k], end = l.at + read(`vo/${l.id}.wav`).length / SR, next = lines[k + 1].at;
  if (next - end < 0.8) continue;
  console.log(`${l.id} 说话 ${(l.at + 0.3).toFixed(1)}-${(end - 0.3).toFixed(1)}s: ${rms(mus, l.at + 0.3, end - 0.3)}   间隙 ${(end + 0.3).toFixed(1)}-${(next - 0.1).toFixed(1)}s: ${rms(mus, end + 0.3, next - 0.1)}`);
}
console.log("== 旁白窗口里：成片 vs 旁白轨 ==", "成片", rms(fin, 15.6, 20.4), "旁白轨", rms(nar, 15.6, 20.4));
let peak = 0; for (const v of fin) peak = Math.max(peak, Math.abs(v)); console.log("成片采样峰值", peak.toFixed(3));
const plan = JSON.parse(readFileSync("plan.json", "utf8"));
const onsets = (t0, t1) => { const on = []; let prev = +rms(sfx, t0 - 0.005, t0); for (let t = t0; t < t1; t += 0.005) { const v = +rms(sfx, t, t + 0.005); if (v - prev > 6 && v > -40) on.push(+t.toFixed(3)); prev = v; } return on; };
console.log("== 像素音起点 5.0–5.95s ==", onsets(5.0, 5.95).join(" "), "| cue:", plan.cues.filter((c) => c.t >= 5.0 && c.t < 5.95).map((c) => c.t).join(" "));
// 徽章音叠在前一声 chime 的尾音上，5ms 上升沿检不灵，改看 cue 前后各 50ms 的能量差
for (const c of plan.cues.filter((c) => c.kind === "reveal")) console.log(`== 能力徽章音（cue ${c.t}s）==`, `前 50ms ${rms(sfx, c.t - 0.05, c.t)} dB → 后 50ms ${rms(sfx, c.t, c.t + 0.05)} dB`);
