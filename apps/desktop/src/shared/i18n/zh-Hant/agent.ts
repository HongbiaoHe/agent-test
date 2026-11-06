import type { MessageShape } from '../shape';
import type { agent as source } from '../zh-CN/agent';

export const agent = {
  client: {
    restarted: 'agent 程序已重新啟動，請重試',
  },
  thinking: {
    label: '思考深度',
    level: {
      auto: '自動',
      off: '關閉',
      on: '開啟',
      low: '低',
      medium: '中',
      high: '高',
    },
    hint: {
      auto: '模型預設，不做調整',
      off: '不思考，最快、最省',
      on: '先思考再回答',
      low: '簡短思考',
      medium: '均衡思考',
      high: '最深入的思考，最慢',
    },
  },
  usage: {
    title: 'Token 用量詳情',
    description:
      '快取命中率 = 命中快取的輸入 token ÷ 輸入 token（provider 回傳的輸入量已包含快取部分）。快取資料自本功能上線起記錄，更早的執行以 0 計。',
    loading: '正在統計…',
    loadFailed: '讀取用量失敗',
    empty: '這個畫布還沒有模型呼叫紀錄。',
    byModel: '依模型（{{n}}）',
    runs: '每輪執行（{{n}}）',
    totalTokens: 'tokens 合計',
    input: '輸入',
    output: '輸出',
    reasoning: '思考',
    cacheRead: '命中快取',
    modelCalls: '模型呼叫',
    callsSuffix: '次',
    cacheRate: '快取命中率',
    cacheWrite: '寫入快取 {{n}}',
    inputN: '輸入 {{n}}',
    outputN: '輸出 {{n}}',
    reasoningN: '思考 {{n}}',
    calls_other: '{{count}} 次呼叫',
    hit: '命中 {{rate}}',
    noGoal: '（續跑，無新目標）',
    runEmpty: '這一輪沒有模型呼叫紀錄。',
    modelTotal_other: '{{total}}（{{count}} 次）',
    time: '時間',
    model: '模型',
    total: '合計',
  },
} satisfies MessageShape<typeof source>;
