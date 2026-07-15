/**
 * 拉丁乘客姓名规范化工具（前端镜像版）
 *
 * 规则须与 backend/src/lib/passenger-name.ts 保持一致：
 *  - 转大写
 *  - 去掉句点；逗号视为姓/名分隔转 '/'（已有 '/' 时逗号只删不重复加）
 *  - 连续空白折叠为单空格，'/' 两侧空格去除，首尾 trim
 *  - 不把纯空格分隔的名字自动改成斜线（如 VAN DER BERG PIET 保持原样）
 *  - 中文等非拉丁字符原样保留不动
 *
 * 用途：录单时姓名格式脏数据入库（如 `ZHENG,/QINQIN` 姓里带逗号）会污染各类导出名单，
 * 此工具在前端边界（OCR 回填 / 常旅客联想回填 / 手动输入 blur）预先规范化，与后端
 * orders.schemas.ts 的服务端兜底校验保持同一套规则。
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
