// PM2 开发环境进程编排：一条 `pnpm dev` 同时拉起前后端。
// 后端用 nest --watch、前端用 next dev，各自负责热重载，故 PM2 不开 watch。
// Node 必须 v22：与 .nvmrc / .claude/launch.json 一致，这里把 nvm 的 v22 路径前置进 PATH，
// 让 `pnpm dev` 在默认 shell（可能是低版本 node）下也能起得来。
const path = require('node:path');

const NODE_BIN = path.join(
  process.env.HOME ?? '',
  '.nvm/versions/node/v22.21.1/bin',
);
const PATH_WITH_NODE22 = `${NODE_BIN}:${process.env.PATH ?? ''}`;

/** @type {{apps: import('pm2').StartOptions[]}} */
module.exports = {
  apps: [
    {
      // agent-core 构建到 dist、backend 吃 dist：nest --watch 不监听 packages/，这里持续增量编译。
      // 注意 nest 也不监听 node_modules 下的 dist，改了 agent-core 后需重启 backend（pnpm dev:restart）。
      name: 'agent-core',
      cwd: __dirname,
      script: 'pnpm',
      args: '--filter @agent-test/agent-core dev',
      interpreter: 'none',
      watch: false,
      env: { NODE_ENV: 'development', PATH: PATH_WITH_NODE22 },
    },
    {
      name: 'backend',
      cwd: __dirname,
      script: 'pnpm',
      args: '--filter backend start:dev',
      interpreter: 'none',
      watch: false,
      env: { NODE_ENV: 'development', PATH: PATH_WITH_NODE22 },
    },
    {
      name: 'frontend',
      cwd: __dirname,
      script: 'bash',
      args: '-c "while ! nc -z localhost 3101 2>/dev/null; do sleep 0.5; done; pnpm --filter frontend dev"',
      interpreter: 'none',
      watch: false,
      env: { NODE_ENV: 'development', PATH: PATH_WITH_NODE22 },
    },
  ],
};
