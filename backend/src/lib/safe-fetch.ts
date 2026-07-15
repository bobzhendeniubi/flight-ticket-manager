import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF 防护的图片抓取。
 *
 * 背景（安全审计）：护照图/凭证图的 URL 可由匿名下单方直接写入（POST /orders 的
 * passportPhotoUrl 是 optionalAuthenticate 可达），随后运营导出 ZIP 时服务端 fetch。
 * 若不校验，攻击者可写入 http://169.254.169.254/... 或 http://内网IP 让服务端代抓，
 * 窃取云元数据/内网凭证，并借无上限响应体做内存 DoS。
 *
 * 本函数是所有护照图抓取的唯一出口，收口三道防线：
 *   1. data:image/... 直接本地解码，永不出网（产品最常见落库形态）
 *   2. 远程仅允许 https，且解析后的 IP 不得落在私网/回环/链路本地/元数据段
 *   3. 禁止跟随重定向（防 3xx 跳内网）+ 响应体字节封顶
 */

const MAX_PHOTO_BYTES = 15_000_000; // 15MB 硬顶，防超大响应体 OOM

/** 私网 / 回环 / 链路本地 / 元数据 / 保留段——命中即拒。 */
function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
    const [a, b] = p;
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 回环
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 链路本地 / 云元数据 169.254.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a >= 224) return true; // 组播 / 保留
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true; // 回环 / 未指定
    if (lower.startsWith('fe80')) return true; // 链路本地
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // 唯一本地 ULA
    if (lower.startsWith('::ffff:')) {
      // IPv4-mapped：按内嵌 v4 复检
      const v4 = lower.slice(7);
      if (isIP(v4) === 4) return isBlockedAddress(v4);
    }
    return false;
  }
  return true; // 非法/无法识别一律拒
}

/**
 * 抓取图片字节。失败（含被 SSRF 防线拒绝）返回 null，由调用方记入缺图明细。
 */
export async function fetchImageSafely(url: string): Promise<Buffer | null> {
  try {
    // data:image/... —— 本地解码，不出网
    if (/^data:/i.test(url)) {
      const m = url.match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/i);
      if (!m) return null;
      const buf = Buffer.from(m[1], 'base64');
      return buf.byteLength > 0 && buf.byteLength <= MAX_PHOTO_BYTES ? buf : null;
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    // 远程仅允许 https
    if (parsed.protocol !== 'https:') return null;

    // 解析主机名 → 校验所有解析出的 IP 都不在禁用段（防 DNS 指向内网）
    const host = parsed.hostname;
    let addrs: string[];
    if (isIP(host)) {
      addrs = [host];
    } else {
      const resolved = await lookup(host, { all: true });
      addrs = resolved.map((r) => r.address);
    }
    if (addrs.length === 0 || addrs.some(isBlockedAddress)) return null;

    // 禁止重定向（3xx→内网 的绕过），10s 超时
    const res = await fetch(parsed, {
      signal: AbortSignal.timeout(10_000),
      redirect: 'manual',
    });
    if (!res.ok) return null;

    // 响应体封顶：优先看 Content-Length，再按实际字节兜底
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > MAX_PHOTO_BYTES) return null;
    const ab = await res.arrayBuffer();
    if (ab.byteLength > MAX_PHOTO_BYTES) return null;
    return Buffer.from(ab);
  } catch {
    return null;
  }
}
