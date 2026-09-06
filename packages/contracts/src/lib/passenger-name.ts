/**
 * 拉丁乘客姓名规范化工具
 *
 * 背景：录单时姓名格式脏数据入库（如 `ZHENG,/QINQIN` 姓里带逗号），
 * 污染各类导出名单。此工具在系统边界统一格式。
 *
 * 规则（见 normalizePassengerFullName）：
 *  - 转大写
 *  - 去掉句点；逗号视为姓/名分隔转 '/'（已有 '/' 时逗号只删不重复加）
 *  - 连续空白折叠为单空格，'/' 两侧空格去除，首尾 trim
 *  - 不把纯空格分隔的名字自动改成斜线（如 VAN DER BERG PIET 保持原样）
 *  - 中文等非拉丁字符原样保留不动
 */

/**
 * 规范化一段拉丁姓名（可能是 `LAST/FIRST`、仅姓、或仅名）。
 * 非拉丁字符（中文等）不受影响，只做大写/空白/标点清理。
 */
export function normalizePassengerFullName(raw: string): string {
  if (typeof raw !== 'string') return '';

  let s = raw.toUpperCase();

  // 去掉句点（如 JR. → JR）
  s = s.replace(/\./g, '');

  if (s.includes('/')) {
    // 已有斜线：逗号只删除，避免重复加分隔符
    s = s.replace(/,/g, '');
  } else {
    // 无斜线：首个逗号视为姓/名分隔转 '/'，其余逗号删除
    let replaced = false;
    s = s.replace(/,/g, () => {
      if (!replaced) {
        replaced = true;
        return '/';
      }
      return '';
    });
  }

  // 连续空白折叠为单空格
  s = s.replace(/\s+/g, ' ');
  // '/' 两侧空格去除
  s = s.replace(/\s*\/\s*/g, '/');
  // 合并多余斜线
  s = s.replace(/\/{2,}/g, '/');
  // 去掉首尾斜线（compose 时各段单独规范化会残留）
  s = s.replace(/^\/+|\/+$/g, '');

  return s.trim();
}

/**
 * 从完整姓名反推 { lastName, firstName }（录单只给了 fullName 时的兜底）。
 *
 * 口径：**斜线优先，其次空格**。
 *  - `ZHANG/SAN`      → last=`ZHANG`, first=`SAN`（航司标准 LAST/FIRST）
 *  - `VAN DER/PIET`   → last=`VAN DER`, first=`PIET`（斜线才是分隔符，空格不是）
 *  - `WANG LIANBO`    → last=`WANG`, first=`LIANBO`（无斜线才按首个空格拆）
 *  - `MADONNA`        → last=`MADONNA`, first=`''`（拆不出就不编造）
 *
 * 为什么必须先看斜线：fullName **允许**带斜线（斜线在全名里是合法分隔符，
 * 入口 schema 只禁止 lastName/firstName 两栏带斜线）。若只按空格拆，
 * `ZHANG/SAN` 会整串掉进 lastName，把「姓」这一栏污染成整个姓名——
 * 而 lastName 一旦落库是脏的，下游各导出的 fullName 兜底逻辑就再也救不回来了
 * （兜底只在 lastName 为空时才触发）。
 */
export function splitPassengerFullName(full?: string | null): {
  lastName: string;
  firstName: string;
} {
  const s = (full ?? '').trim();
  if (!s) return { lastName: '', firstName: '' };

  const slash = s.indexOf('/');
  if (slash > 0) {
    const last = s.slice(0, slash).trim();
    const first = s.slice(slash + 1).trim();
    if (last && first) return { lastName: last, firstName: first };
  }

  const [head, ...rest] = s.split(/\s+/);
  return { lastName: head ?? '', firstName: rest.join(' ') };
}

/**
 * 由姓、名分别组合出完整姓名 `LAST/FIRST NAMES`（各自内部先规范化）。
 * 只有一个字段 → 规范化后原样返回；两者皆空 → null。
 */
export function composePassengerFullName(
  last?: string | null,
  first?: string | null,
): string | null {
  const l = last ? normalizePassengerFullName(last) : '';
  const f = first ? normalizePassengerFullName(first) : '';

  if (l && f) return `${l}/${f}`;
  if (l) return l;
  if (f) return f;
  return null;
}
