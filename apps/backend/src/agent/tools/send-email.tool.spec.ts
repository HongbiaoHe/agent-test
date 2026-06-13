import { sendEmailTool } from './send-email.tool';

describe('sendEmailTool', () => {
  const OLD_ENV = process.env.DEFAULT_EMAIL_TO;
  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.DEFAULT_EMAIL_TO;
    else process.env.DEFAULT_EMAIL_TO = OLD_ENV;
  });

  it('缺省 to 时落到内置示例地址', async () => {
    delete process.env.DEFAULT_EMAIL_TO;
    const raw = await sendEmailTool.invoke({ subject: 's', body: 'b' });
    expect(JSON.parse(raw as string).to).toBe('team@example.com');
  });

  it('缺省 to 时优先取 DEFAULT_EMAIL_TO env', async () => {
    process.env.DEFAULT_EMAIL_TO = 'ops@corp.io';
    const raw = await sendEmailTool.invoke({ subject: 's', body: 'b' });
    expect(JSON.parse(raw as string).to).toBe('ops@corp.io');
  });

  it('显式传 to 时用显式值', async () => {
    process.env.DEFAULT_EMAIL_TO = 'ops@corp.io';
    const raw = await sendEmailTool.invoke({
      to: 'a@b.c',
      subject: 's',
      body: 'b',
    });
    expect(JSON.parse(raw as string).to).toBe('a@b.c');
  });
});
