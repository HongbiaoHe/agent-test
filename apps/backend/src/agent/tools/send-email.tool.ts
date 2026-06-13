import { tool } from '@langchain/core/tools';
import { z } from 'zod';

/** demo 敏感工具：演示需审批的写操作（固定返回成功，不真发邮件）。 */

/** 缺省收件人：env 可覆盖，兜底示例地址（demo 不真发，无泄露风险）。 */
const defaultTo = () => process.env.DEFAULT_EMAIL_TO ?? 'team@example.com';

export const sendEmailTool = tool(
  ({ to, subject }: { to?: string; subject: string; body: string }) =>
    JSON.stringify({ sent: true, to: to ?? defaultTo(), subject }),
  {
    name: 'send_email',
    description:
      'Send an email (demo; sensitive action, requires user approval before execution). Omit "to" to use the system default recipient.',
    schema: z.object({
      to: z
        .string()
        .optional()
        .describe(
          'Recipient email address. Omit to use the system default recipient.',
        ),
      subject: z.string().describe('Email subject'),
      body: z.string().describe('Email body'),
    }),
  },
);
