import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { sanitizeToolSchema } from './mcp-schema';

/** Gemini 会整轮 400 的关键字：清洗结果里一个都不能有。 */
const FORBIDDEN = [
  'propertyNames',
  'patternProperties',
  'additionalProperties',
  '$ref',
  '$defs',
  'definitions',
  '$schema',
  'const',
  'oneOf',
  'allOf',
  'examples',
];

function keysDeep(v: unknown, acc = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, acc));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      acc.add(k);
      keysDeep(x, acc);
    }
  }
  return acc;
}

describe('sanitizeToolSchema', () => {
  it('BuzzVideo 的真实 24 个工具全部可清洗、且不含 Gemini 不认的关键字', () => {
    const tools = JSON.parse(
      readFileSync(
        join(__dirname, '__fixtures__/buzzvideo-tools.json'),
        'utf8',
      ),
    ) as Tool[];
    expect(tools).toHaveLength(24);
    for (const t of tools) {
      const r = sanitizeToolSchema(t.inputSchema);
      expect(r.error).toBeUndefined();
      const keys = keysDeep(r.schema);
      for (const k of FORBIDDEN) expect(keys.has(k)).toBe(false);
      expect(r.schema?.type).toBe('object');
    }
  });

  it('删掉 propertyNames / patternProperties / additionalProperties（z.record 产物）', () => {
    const r = sanitizeToolSchema({
      type: 'object',
      properties: {
        tags: {
          type: 'object',
          propertyNames: { type: 'string' },
          additionalProperties: { type: 'string' },
          patternProperties: { '^x': { type: 'number' } },
        },
      },
    });
    expect(r.schema).toEqual({
      type: 'object',
      properties: { tags: { type: 'object' } },
    });
  });

  it('展开本地 $ref / $defs，保留 required', () => {
    const r = sanitizeToolSchema({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      $defs: { Size: { type: 'string', enum: ['s', 'm'] } },
      properties: { size: { $ref: '#/$defs/Size', description: 'size' } },
      required: ['size', 'ghost'],
    });
    expect(r.schema).toEqual({
      type: 'object',
      properties: {
        size: { type: 'string', enum: ['s', 'm'], description: 'size' },
      },
      required: ['size'],
    });
  });

  it('循环 $ref 判不兼容', () => {
    const r = sanitizeToolSchema({
      type: 'object',
      definitions: {
        Node: {
          type: 'object',
          properties: { child: { $ref: '#/definitions/Node' } },
        },
      },
      properties: { root: { $ref: '#/definitions/Node' } },
    });
    expect(r.error).toMatch(/recursive/);
  });

  it('const → 单值 enum；type 数组 → nullable；oneOf → anyOf', () => {
    const r = sanitizeToolSchema({
      type: 'object',
      properties: {
        kind: { const: 'video' },
        note: { type: ['string', 'null'] },
        target: { oneOf: [{ type: 'string' }, { type: 'number' }] },
        maybe: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
      },
    });
    expect(r.schema?.properties).toEqual({
      kind: { type: 'string', enum: ['video'] },
      note: { type: 'string', nullable: true },
      target: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      maybe: { type: 'integer', nullable: true },
    });
  });

  it('非字符串 enum 与 Gemini 不认的 format 改写进 description', () => {
    const r = sanitizeToolSchema({
      type: 'object',
      properties: {
        n: { type: 'integer', enum: [1, 2] },
        url: { type: 'string', format: 'uri', description: 'link' },
        at: { type: 'string', format: 'date-time' },
      },
    });
    expect(r.schema?.properties).toEqual({
      n: { type: 'integer', description: 'allowed values: 1, 2' },
      url: { type: 'string', description: 'link (format: uri)' },
      at: { type: 'string', format: 'date-time' },
    });
  });

  it('根不是 object / 元组数组 / 远程 $ref 判不兼容', () => {
    expect(sanitizeToolSchema({ type: 'string' }).error).toBeDefined();
    expect(
      sanitizeToolSchema({
        type: 'object',
        properties: { p: { type: 'array', items: [{ type: 'string' }] } },
      }).error,
    ).toMatch(/tuple/);
    expect(
      sanitizeToolSchema({
        type: 'object',
        properties: { p: { $ref: 'https://x.dev/s.json' } },
      }).error,
    ).toMatch(/\$ref/);
  });

  it('空 schema（无参工具）补出空 properties', () => {
    expect(sanitizeToolSchema({ type: 'object' }).schema).toEqual({
      type: 'object',
      properties: {},
    });
  });
});
