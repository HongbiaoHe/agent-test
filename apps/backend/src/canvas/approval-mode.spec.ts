import { asApprovalMode, CANVAS_APPROVAL_MODES } from './canvas.types';

describe('asApprovalMode', () => {
  it('只认 auto，其余一律回退到 review', () => {
    expect(asApprovalMode('auto')).toBe('auto');
    expect(asApprovalMode('review')).toBe('review');
    // 放行是不可逆的：旧数据、脏值、未设置都必须落到保守的那一边
    expect(asApprovalMode(null)).toBe('review');
    expect(asApprovalMode(undefined)).toBe('review');
    expect(asApprovalMode('')).toBe('review');
    expect(asApprovalMode('AUTO')).toBe('review');
    expect(asApprovalMode(1)).toBe('review');
    expect(asApprovalMode({ mode: 'auto' })).toBe('review');
  });

  it('模式清单就这两种', () => {
    expect(CANVAS_APPROVAL_MODES).toEqual(['review', 'auto']);
  });
});
