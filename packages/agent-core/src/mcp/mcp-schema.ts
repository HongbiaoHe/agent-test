/**
 * MCP 工具 inputSchema → 能安全喂给模型的 JSON Schema。
 *
 * 为什么必须清洗：inputSchema 是第三方 server 给的原始 JSON Schema，而 Gemini 只收 OpenAPI 子集，
 * 遇到不认识的关键字（propertyNames / patternProperties / $ref …）会让**整轮**请求 400，
 * 一个外部 server 写得不规范就能让用户所有对话跑不起来。这里白名单保留关键字，
 * 能等价改写的改写（$ref 展开、const → 单值 enum、type 数组 → nullable / anyOf），
 * 改写不了的返回 error，调用方把该工具标成「不兼容」不注入。
 */

type Json = Record<string, unknown>;

export type SanitizeResult =
  | { schema: Json; error?: undefined }
  | { schema?: undefined; error: string };

/** 原样保留的标量关键字（Gemini OpenAPI 子集里支持的）。 */
const KEEP = new Set([
  'description',
  'title',
  'nullable',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'pattern',
  'default',
]);

/** Gemini 认的 format：其它值会 400，丢掉并把原值写进 description。 */
const FORMATS: Record<string, string[]> = {
  string: ['date-time', 'enum'],
  integer: ['int32', 'int64'],
  number: ['float', 'double'],
};

const TYPES = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'object',
  'array',
]);

const MAX_DEPTH = 32;

class SchemaError extends Error {}

function isObject(v: unknown): v is Json {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function appendDescription(node: Json, note: string): void {
  const prev = typeof node.description === 'string' ? node.description : '';
  node.description = prev ? `${prev} (${note})` : note;
}

/** 只认本文档内的 `#/$defs/X` / `#/definitions/X`；远程引用、JSON Pointer 转义一律不支持。 */
function resolveRef(ref: string, root: Json): Json {
  const m = /^#\/(\$defs|definitions)\/([^/]+)$/.exec(ref);
  if (!m) throw new SchemaError(`unsupported $ref ${ref}`);
  const defs = root[m[1]];
  const target = isObject(defs) ? defs[m[2]] : undefined;
  if (!isObject(target)) throw new SchemaError(`unresolved $ref ${ref}`);
  return target;
}

function sanitizeNode(input: unknown, root: Json, refs: string[]): Json {
  if (refs.length > MAX_DEPTH) throw new SchemaError('schema too deep');
  if (input === true || input === undefined) return {};
  if (!isObject(input)) throw new SchemaError('schema node is not an object');

  const node = input;
  if (typeof node.$ref === 'string') {
    // 循环引用（递归结构）展不开，Gemini 也不支持：判不兼容
    if (refs.includes(node.$ref)) {
      throw new SchemaError(`recursive $ref ${node.$ref}`);
    }
    const resolved = resolveRef(node.$ref, root);
    const { $ref: ref, ...rest } = node;
    return sanitizeNode(
      { ...resolved, ...rest },
      root,
      refs.concat(String(ref)),
    );
  }

  // allOf：单个分支直接并入，多分支（真正的交集）改写不了
  if (Array.isArray(node.allOf)) {
    if (node.allOf.length !== 1) throw new SchemaError('allOf not supported');
    const { allOf, ...rest } = node;
    return sanitizeNode({ ...(allOf[0] as Json), ...rest }, root, refs);
  }

  const out: Json = {};
  for (const [k, v] of Object.entries(node)) {
    if (KEEP.has(k)) out[k] = v;
  }

  // type：数组形式拆成 nullable + 单类型；多个非 null 类型改写成 anyOf
  let type: unknown = node.type;
  if (Array.isArray(type)) {
    const types: unknown[] = type;
    const nonNull = types.filter((t) => t !== 'null');
    if (nonNull.length < types.length) out.nullable = true;
    if (nonNull.length === 1) {
      type = nonNull[0];
    } else {
      out.anyOf = nonNull.map((t) =>
        sanitizeNode({ ...node, type: t }, root, refs),
      );
      return out;
    }
  }
  if (type === undefined && isObject(node.properties)) type = 'object';
  if (type !== undefined) {
    if (typeof type !== 'string' || !TYPES.has(type)) {
      throw new SchemaError(`unsupported type ${JSON.stringify(type)}`);
    }
    out.type = type;
  }

  if (typeof node.format === 'string') {
    if (typeof type === 'string' && FORMATS[type]?.includes(node.format)) {
      out.format = node.format;
    } else {
      appendDescription(out, `format: ${node.format}`);
    }
  }

  // const → 单值 enum；Gemini 的 enum 只收字符串，其它取值写进 description
  const values: unknown[] | undefined =
    'const' in node
      ? [node.const]
      : Array.isArray(node.enum)
        ? node.enum
        : undefined;
  if (values) {
    if (values.every((v) => typeof v === 'string')) {
      out.enum = values;
      if (!out.type) out.type = 'string';
    } else {
      appendDescription(
        out,
        `allowed values: ${values.map((v) => JSON.stringify(v)).join(', ')}`,
      );
    }
  }

  // oneOf 与 anyOf 对模型而言语义足够接近（都是「其中之一」）
  const union = Array.isArray(node.anyOf)
    ? node.anyOf
    : Array.isArray(node.oneOf)
      ? node.oneOf
      : undefined;
  if (union) {
    const variants = union.filter((s) => !(isObject(s) && s.type === 'null'));
    if (variants.length < union.length) out.nullable = true;
    if (variants.length === 1) {
      return { ...out, ...sanitizeNode(variants[0], root, refs) };
    }
    out.anyOf = variants.map((s) => sanitizeNode(s, root, refs));
  }

  if (out.type === 'object' && isObject(node.properties)) {
    const props: Json = {};
    for (const [k, v] of Object.entries(node.properties)) {
      props[k] = sanitizeNode(v, root, refs);
    }
    out.properties = props;
    if (Array.isArray(node.required)) {
      const required = node.required.filter(
        (r): r is string => typeof r === 'string' && r in props,
      );
      if (required.length > 0) out.required = required;
    }
  }

  if (out.type === 'array') {
    // 元组形式（items 为数组 / prefixItems）不支持；缺 items 时按任意字符串处理不安全，判不兼容
    if (Array.isArray(node.items) || 'prefixItems' in node) {
      throw new SchemaError('tuple arrays not supported');
    }
    if (!isObject(node.items)) throw new SchemaError('array without items');
    out.items = sanitizeNode(node.items, root, refs);
  }

  return out;
}

export function sanitizeToolSchema(input: unknown): SanitizeResult {
  if (!isObject(input)) return { error: 'inputSchema is not an object' };
  try {
    const schema = sanitizeNode(input, input, []);
    if (schema.type !== 'object') {
      return { error: 'inputSchema root must be an object' };
    }
    if (!isObject(schema.properties)) schema.properties = {};
    return { schema };
  } catch (e) {
    if (e instanceof SchemaError) return { error: e.message };
    throw e;
  }
}
