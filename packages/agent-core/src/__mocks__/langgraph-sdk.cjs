// jest 专用桩：@langchain/langgraph-sdk 的 CJS 构建仍 require 纯 ESM 的 p-retry / p-queue，
// ts-jest 的 CJS 环境加载不了；deepagents 在 import 时就会拉到它，但运行期只在 LangSmithSandbox
// 里 new Client()，本包测试不碰。仅经 package.json 的 jest.moduleNameMapper 生效，不进 build。
module.exports = {
  Client: class Client {
    constructor() {
      throw new Error('@langchain/langgraph-sdk 在 jest 里是桩，不能真用');
    }
  },
};
