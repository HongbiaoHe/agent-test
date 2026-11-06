import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { ToolDescriptor } from '../../modes/tool-registry';

/** demo 工具：返回假天气数据，用于在 skeleton 中演示 tool-calling 循环。 */
export const getWeatherTool = tool(
  ({ city }: { city: string }) => {
    return JSON.stringify({ city, tempC: 23, condition: '晴', source: 'mock' });
  },
  {
    name: 'get_weather',
    description: '查询指定城市的当前天气（演示用，返回固定假数据）',
    schema: z.object({
      city: z.string().describe('城市名称，如 北京'),
    }),
  },
);

/** 注册表用的描述符（示例工具不再由 core 硬编码进 agent，宿主要用就注册它）。 */
export const getWeatherDescriptor: ToolDescriptor = {
  name: 'get_weather',
  title: '天气（演示）',
  description: '查询指定城市的当前天气，返回固定假数据',
  create: () => getWeatherTool,
};
