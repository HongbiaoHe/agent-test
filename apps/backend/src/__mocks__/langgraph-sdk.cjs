// jest 专用桩：@langchain/langgraph-sdk 的 CJS 构建仍 require 纯 ESM 的 p-retry / p-queue，
// ts-jest 的 CJS 环境加载不了；agent-core 的 skills-mount（经 agent/sandbox.ts 转发）在 import 时
// 就会经 deepagents 拉到它，但运行期只在 LangSmithSandbox 里 new Client()，backend 测试不碰。
// 仅经 package.json 的 jest.moduleNameMapper 生效，不进 build（nest-cli 只编 .ts）。
module.exports = {
  Client: class Client {
    constructor() {
      throw new Error('@langchain/langgraph-sdk 在 jest 里是桩，不能真用');
    }
  },
};
