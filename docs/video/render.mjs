// 用法：node render.mjs cues plan.json      → 导出音效时间点 + 配乐段落（真实时间）
//       node render.mjs stills 1.5 7 ...   → 截几张静帧到 stills/
//       node render.mjs video out.mp4        → 30fps 逐帧喂给 ffmpeg
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("/Users/biu/.npm/_npx/705bc6b22212b352/node_modules/playwright-core");

const [mode, ...rest] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on("console", (m) => console.log("[page]", m.text()));
page.on("pageerror", (e) => { console.error("[pageerror]", e); process.exit(1); });
await page.goto("file://" + new URL("./video.html", import.meta.url).pathname);
await page.evaluate(() => window.ready);
const grab = (t) => page.evaluate((t) => { window.draw(t); return document.getElementById("c").toDataURL("image/png"); }, t);
const buf = (d) => Buffer.from(d.slice(d.indexOf(",") + 1), "base64");

if (mode === "cues") {
  writeFileSync(rest[0] ?? "plan.json", JSON.stringify(await page.evaluate(() => window.audioPlan()), null, 1));
} else if (mode === "stills") {
  mkdirSync("stills", { recursive: true });
  for (const t of rest) writeFileSync(`stills/t${t}.png`, buf(await grab(Number(t))));
} else {
  const out = rest[0] ?? "out.mp4", fps = 30;
  const dur = await page.evaluate(() => window.DURATION);
  const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-i", "-",
    "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out], { stdio: ["pipe", "inherit", "inherit"] });
  const n = Math.round(dur * fps);
  for (let f = 0; f < n; f++) {
    const ok = ff.stdin.write(buf(await grab(f / fps)));
    if (!ok) await new Promise((r) => ff.stdin.once("drain", r));
    if (f % 150 === 0) console.log(`frame ${f}/${n}`);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on("close", r));
}
await browser.close();
