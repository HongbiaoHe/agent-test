import { userMessageSummary, userMessageText } from './message-content';

describe('userMessageText（重放给模型的用户消息）', () => {
  it('老消息只有 text：原样返回', () => {
    expect(userMessageText({ text: 'hello' })).toBe('hello');
  });

  it('带附件：正文后拼一段「[附件]」清单', () => {
    expect(
      userMessageText({
        text: '做成视频',
        attachments: [
          {
            versionId: 'v1',
            type: 'image',
            url: 'https://cdn/a.png',
            filename: 'a.png',
            contentType: 'image/png',
          },
        ],
      }),
    ).toBe('做成视频\n\n[附件]\n- image versionId=v1 文件名 a.png');
  });

  it('只有附件没有正文：只剩附件清单', () => {
    expect(
      userMessageText({
        text: '',
        attachments: [{ versionId: 'v2', type: 'audio', filename: 'b.mp3' }],
      }),
    ).toBe('[附件]\n- audio versionId=v2 文件名 b.mp3');
  });

  it('形状不对（非对象）→ 空串', () => {
    expect(userMessageText('oops')).toBe('');
    expect(userMessageText(null)).toBe('');
  });
});

describe('userMessageSummary（token 报表里的本轮目标）', () => {
  it('有正文用正文；只有附件列文件名；形状不对为空', () => {
    expect(userMessageSummary({ text: ' 做成视频 ' })).toBe('做成视频');
    expect(
      userMessageSummary({
        text: '',
        attachments: [
          { versionId: 'v1', type: 'image', filename: 'a.png' },
          { versionId: 'v2', type: 'video', filename: 'b.mp4' },
        ],
      }),
    ).toBe('[a.png, b.mp4]');
    expect(userMessageSummary(null)).toBe('');
  });
});
