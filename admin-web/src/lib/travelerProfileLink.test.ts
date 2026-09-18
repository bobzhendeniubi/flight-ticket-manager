import { describe, it, expect } from 'vitest';
import { travelerProfileLinkProps } from './travelerProfileLink';

describe('travelerProfileLinkProps', () => {
  it('有档案 id 时按 id 直达，档案 id 可以留在地址栏', () => {
    expect(
      travelerProfileLinkProps({
        profileId: 'p1',
        documentType: 'PASSPORT',
        documentNumber: 'E123',
      }),
    ).toEqual({ to: '/travelers?profile=p1' });
  });

  it('档案 id 里的特殊字符做 URL 转义', () => {
    expect(travelerProfileLinkProps({ profileId: 'a b/c' })).toEqual({
      to: '/travelers?profile=a%20b%2Fc',
    });
  });

  it('只有证件号时走 Link state —— 证件号绝不进地址栏', () => {
    const props = travelerProfileLinkProps({ documentType: 'ID_CARD', documentNumber: 'E123' });
    expect(props).toEqual({ to: '/travelers', state: { doc: 'E123', docType: 'ID_CARD' } });
    expect(props!.to).not.toContain('E123');
  });

  it('证件类型缺省按护照', () => {
    expect(travelerProfileLinkProps({ documentNumber: ' E123 ' })).toEqual({
      to: '/travelers',
      state: { doc: 'E123', docType: 'PASSPORT' },
    });
  });

  it('档案 id 与证件号都没有 → null（调用方渲染成纯文本）', () => {
    expect(travelerProfileLinkProps({ profileId: '', documentNumber: '   ' })).toBeNull();
    expect(travelerProfileLinkProps({})).toBeNull();
  });
});
