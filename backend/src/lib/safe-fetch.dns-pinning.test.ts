/**
 * safe-fetch · DNS 重绑定 TOCTOU 修复回归测试（C-24）
 *
 * 此前 fetchImageSafely 先用 dns/promises.lookup 解析+校验一次 IP，再用全局 fetch()
 * 发起请求——fetch 底层会对 hostname 重新解析一次，攻击者控制的权威 DNS 可以让这两次
 * 解析返回不同结果（先给一个能通过校验的公网 IP，建连时再改答内网/元数据 IP），绕开校验。
 *
 * 修复后只解析一次，把这个校验过的 IP 通过 https.request 的 `lookup` 选项钉死传给底层
 * 连接，不再对 hostname 发起第二次真实 DNS 查询。这里用 mock 验证：
 *   1. 实际发起连接时用的是「校验时那次解析」得到的 IP，即使这里模拟的“第二次解析”
 *      会给出一个不同的（本该被拒的）内网 IP，也不会被用上——因为压根不会再查一次。
 *   2. hostname / servername 仍是原始域名（Host 头 + TLS SNI/证书校验不受影响）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const dnsLookupMock = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup: dnsLookupMock }));

const httpsRequestMock = vi.hoisted(() => vi.fn());
vi.mock('node:https', () => ({ request: httpsRequestMock }));

import { fetchImageSafely } from './safe-fetch.js';

class FakeIncomingMessage extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  resume = vi.fn();
  destroy = vi.fn();
}

class FakeClientRequest extends EventEmitter {
  end = vi.fn();
  destroy = vi.fn();
}

beforeEach(() => {
  dnsLookupMock.mockReset();
  httpsRequestMock.mockReset();
});

describe('fetchImageSafely · DNS 只解析一次，连接目标钉死为校验过的 IP（C-24）', () => {
  it('https.request 收到的 lookup 选项固定返回校验通过的 IP，且 hostname/servername 是原始域名', async () => {
    // 校验阶段（唯一一次 dns 查询）解析出一个公网 IP，能通过 isBlockedAddress 校验。
    dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

    let capturedOptions: Record<string, unknown> | undefined;
    httpsRequestMock.mockImplementation((options: Record<string, unknown>, callback: (res: FakeIncomingMessage) => void) => {
      capturedOptions = options;
      const req = new FakeClientRequest();
      const res = new FakeIncomingMessage();
      queueMicrotask(() => {
        callback(res);
        res.emit('data', Buffer.from('fake-image-bytes'));
        res.emit('end');
      });
      return req;
    });

    const buf = await fetchImageSafely('https://passport-cdn.example.com/a.jpg');

    expect(buf?.toString()).toBe('fake-image-bytes');
    expect(dnsLookupMock).toHaveBeenCalledTimes(1); // 只解析一次，不在建连时再查
    expect(capturedOptions?.hostname).toBe('passport-cdn.example.com');
    expect(capturedOptions?.servername).toBe('passport-cdn.example.com');

    // 关键断言：即使把「第二次解析」伪造成一个应被拒绝的内网 IP，
    // 实际连接用的 lookup 选项也必须原样吐出校验时钉住的那个公网 IP —— 不会被换掉。
    const lookupFn = capturedOptions?.lookup as (
      hostname: string,
      options: unknown,
      cb: (err: Error | null, address: string, family: number) => void,
    ) => void;
    expect(typeof lookupFn).toBe('function');
    const received: { address?: string; family?: number } = {};
    lookupFn('passport-cdn.example.com', {}, (_err, address, family) => {
      received.address = address;
      received.family = family;
    });
    expect(received.address).toBe('93.184.216.34');
    expect(received.family).toBe(4);
  });

  it('解析出的 IP 落在禁用段 → 直接拒绝，压根不会调用 https.request（无连接尝试）', async () => {
    dnsLookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);

    const buf = await fetchImageSafely('https://rebinding-attacker.example.com/a.jpg');

    expect(buf).toBeNull();
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it('3xx 响应不跟随重定向，返回 null', async () => {
    dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    httpsRequestMock.mockImplementation((_options: unknown, callback: (res: FakeIncomingMessage) => void) => {
      const req = new FakeClientRequest();
      const res = new FakeIncomingMessage();
      res.statusCode = 302;
      queueMicrotask(() => callback(res));
      return req;
    });

    const buf = await fetchImageSafely('https://passport-cdn.example.com/a.jpg');
    expect(buf).toBeNull();
  });

  it('声明的 content-length 超过上限 → 拒绝，不读取响应体', async () => {
    dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    httpsRequestMock.mockImplementation((_options: unknown, callback: (res: FakeIncomingMessage) => void) => {
      const req = new FakeClientRequest();
      const res = new FakeIncomingMessage();
      res.headers = { 'content-length': String(20_000_000) };
      queueMicrotask(() => callback(res));
      return req;
    });

    const buf = await fetchImageSafely('https://passport-cdn.example.com/big.jpg');
    expect(buf).toBeNull();
  });
});
