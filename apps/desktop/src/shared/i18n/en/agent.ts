import type { MessageShape } from '../shape';
import type { agent as source } from '../zh-CN/agent';

export const agent = {
  client: {
    restarted: 'The agent process restarted. Please try again.',
  },
  thinking: {
    label: 'Thinking depth',
    level: {
      auto: 'Auto',
      off: 'Off',
      on: 'On',
      low: 'Low',
      medium: 'Medium',
      high: 'High',
    },
    hint: {
      auto: 'Model default, unchanged',
      off: 'No thinking. Fastest and cheapest',
      on: 'Think before answering',
      low: 'Brief thinking',
      medium: 'Balanced thinking',
      high: 'Deepest thinking, slowest',
    },
  },
  usage: {
    title: 'Token usage details',
    description:
      'Cache hit rate = cached input tokens ÷ input tokens (the input count reported by the provider already includes the cached part). Cache data is recorded since this feature launched; earlier runs count as 0.',
    loading: 'Calculating…',
    loadFailed: 'Failed to load usage',
    empty: 'No model calls recorded for this canvas yet.',
    byModel: 'By model ({{n}})',
    runs: 'Runs ({{n}})',
    totalTokens: 'tokens total',
    input: 'Input',
    output: 'Output',
    reasoning: 'Thinking',
    cacheRead: 'Cache hits',
    modelCalls: 'Model calls',
    callsSuffix: '',
    cacheRate: 'Cache hit rate',
    cacheWrite: 'cache writes {{n}}',
    inputN: 'Input {{n}}',
    outputN: 'Output {{n}}',
    reasoningN: 'Thinking {{n}}',
    calls_one: '{{count}} call',
    calls_other: '{{count}} calls',
    hit: 'Hits {{rate}}',
    noGoal: '(Continued run, no new goal)',
    runEmpty: 'No model calls recorded in this run.',
    modelTotal_one: '{{total}} ({{count}} call)',
    modelTotal_other: '{{total}} ({{count}} calls)',
    time: 'Time',
    model: 'Model',
    total: 'Total',
  },
} satisfies MessageShape<typeof source>;
