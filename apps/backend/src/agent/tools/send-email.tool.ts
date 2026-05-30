import { tool } from '@langchain/core/tools';
import { z } from 'zod';

/** demo 敏感工具：演示需审批的写操作（固定返回成功，不真发邮件）。 */
export const sendEmailTool = tool(
  async ({ to, subject }: { to: string; subject: string; body: string }) =>
    JSON.stringify({ sent: true, to, subject }),
  {
    name: 'send_email',
    description: '给指定收件人发送邮件（演示用，属敏感操作，执行前需用户审批）',
    schema: z.object({
      to: z.string().describe('收件人邮箱'),
      subject: z.string().describe('邮件主题'),
      body: z.string().describe('邮件正文'),
    }),
  },
);
