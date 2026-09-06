import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { request as httpsRequest } from 'node:https';

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
 *
 * C-24（DNS 重绑定 TOCTOU）：此前「解析校验」和「真正发起连接」是两次独立的 DNS 查询——
 * 用全局 fetch() 时，undici 在真正建连时会对 hostname 重新解析一次。攻击者控制的权威 DNS
 * 可以让这两次查询返回不同结果（先给一个能通过校验的公网 IP，几秒后对同一域名改答内网/
 * 元数据 IP），从而绕开上面刚做的 isBlockedAddress 校验。
 * 修法：只解析一次，校验通过后，把这个具体 IP”钉死”给实际发起连接的那一步，不再让底层
 * 对 hostname 做第二次解析。undici 提供 Agent({ connect: { lookup } }) 可以做到这点，但
 * undici 只是本仓库的间接依赖（经 urllib 传递引入，backend/package.json 未声明直接依赖），
 * 直接 import 有版本漂移风险；这里改用 Node 内置的 https.request，它原生支持 `lookup`
 * 选项（与 net.connect 的 lookup 语义一致）：hostname/servername 仍是原始域名（Host 头与
 * TLS SNI/证书校验都不受影响），但底层 net.connect 会调用我们提供的 lookup 函数，直接返回
 * 校验过的那个 IP，不再对 hostname 发起第二次真实 DNS 查询。
 */

const MAX_PHOTO_BYTES = 15_000_000; // 15MB 硬顶，防超大响应体 OOM
const FETCH_TIMEOUT_MS = 10_000;

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
 * 用「钉死」的 IP 发起一次 GET 请求（不跟随重定向、限时、限响应体大小）。
 * hostname/servername 仍传原始域名，只有底层实际连接的目标 IP 被固定，
 * 避免 https.request 内部对 hostname 再做一次可被 DNS 重绑定利用的解析。
 */
function fetchViaPinnedIp(parsed: URL, pinnedIp: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const pinnedFamily = isIP(pinnedIp) === 6 ? 6 : 4;
    const pinnedLookup: LookupFunction = (_hostname, _options, callback) => {
      callback(null, pinnedIp, pinnedFamily);
    };

    let settled = false;
    const finish = (result: Buffer | null) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = httpsRequest(
      {
        hostname: parsed.hostname, // Host 头仍用原始域名
        servername: parsed.hostname, // TLS SNI / 证书域名校验仍按原始域名
        port: parsed.port || 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        lookup: pinnedLookup, // 关键：连接目标钉死为上面已校验过的 IP，不再二次解析
        timeout: FETCH_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // 手动模式：不跟随 3xx（防止跳转到内网地址绕过校验）
        if (status < 200 || status >= 300) {
          res.resume();
          finish(null);
          return;
        }
        const declared = Number(res.headers['content-length'] ?? '0');
        if (declared > MAX_PHOTO_BYTES) {
          res.destroy();
          finish(null);
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_PHOTO_BYTES) {
            req.destroy();
            finish(null);
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => finish(Buffer.concat(chunks)));
        res.on('error', () => finish(null));
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => finish(null));
    req.end();
  });
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
    let pinnedIp: string;
    if (isIP(host)) {
      // URL 本身就是字面量 IP：没有域名解析这一步，也就没有「解析结果不一致」的重绑定窗口。
      if (isBlockedAddress(host)) return null;
      pinnedIp = host;
    } else {
      const resolved = await lookup(host, { all: true });
      const addrs = resolved.map((r) => r.address);
      if (addrs.length === 0 || addrs.some(isBlockedAddress)) return null;
      // 只解析这一次；下面发起连接时把这个具体 IP 钉死传给 https.request 的 lookup 选项，
      // 不再让 Node 对 hostname 发起第二次真实 DNS 查询（见文件头 C-24 注释）。
      pinnedIp = addrs[0];
    }

    return await fetchViaPinnedIp(parsed, pinnedIp);
  } catch {
    return null;
  }
}
