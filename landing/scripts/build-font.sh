#!/usr/bin/env bash
# 重新生成官网展示字体的子集。
#
# 为什么要自托管子集：Google Fonts 在大陆被墙，目标受众是国内旅行社与 OTA 渠道，
# 外链等于静默失效。所以把思源宋体按本页实际用到的字符子集化后随站发布。
#
# 什么时候要重跑：改了标题 / 数字 / 任何用 --font-display 渲染的文案之后。
# 不重跑的话，新增的字会掉回系统字体，同一行里字体不一致，很显眼。
#
# 用法：  bash landing/scripts/build-font.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

SRC_URL="https://github.com/notofonts/noto-cjk/raw/main/Serif/SubsetOTF/SC/NotoSerifSC-SemiBold.otf"
OUT="$ROOT/landing/assets/font/noto-serif-sc-600.v2.woff2"

echo "==> 准备子集化工具（fontTools + brotli，装在临时 venv，不污染系统环境）"
python3 -m venv "$WORK/venv"
"$WORK/venv/bin/pip" install -q fonttools brotli

echo "==> 抽取页面实际用到的字符"
"$WORK/venv/bin/python" - "$ROOT" "$WORK" <<'PY'
import re, sys, pathlib
root, work = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
html = (root / 'landing/index.html').read_text(encoding='utf-8')
body = html.split('<body>', 1)[1] if '<body>' in html else html
body = re.sub(r'<script.*?</script>|<style.*?</style>|<!--.*?-->', ' ', body, flags=re.S)
text = re.sub(r'<[^>]+>', ' ', body)
for ent, ch in (('&nbsp;', ' '), ('&amp;', '&'), ('&copy;', '©'), ('&lt;', '<'), ('&gt;', '>')):
    text = text.replace(ent, ch)
chars = {c for c in text if not c.isspace()}
# 安全余量：拉丁字母、数字、常用中英标点。宁可多几百字节，也不要标题里掉一个字。
chars |= set('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
             '·—–，。、：；（）「」《》%+&.,/()[]#@!?"\'')
(work / 'charset.txt').write_text(''.join(sorted(chars)), encoding='utf-8')
print(f'    字符数：{len(chars)}')
PY

echo "==> 下载思源宋体 SemiBold（SIL OFL，约 11MB，只在构建时下，不进版本库）"
curl -sL --max-time 300 -o "$WORK/src.otf" "$SRC_URL"

echo "==> 子集化并压成 woff2"
"$WORK/venv/bin/pyftsubset" "$WORK/src.otf" \
  --text-file="$WORK/charset.txt" \
  --flavor=woff2 \
  --layout-features='' \
  --no-hinting \
  --desubroutinize \
  --output-file="$OUT"

echo "==> 校验：页面里不能有任何字掉出子集"
"$WORK/venv/bin/python" - "$ROOT" "$OUT" <<'PY'
import re, sys, pathlib
from fontTools.ttLib import TTFont
root, out = pathlib.Path(sys.argv[1]), sys.argv[2]
cmap = set(TTFont(out).getBestCmap())
html = (root / 'landing/index.html').read_text(encoding='utf-8')
body = re.sub(r'<script.*?</script>|<style.*?</style>|<!--.*?-->', ' ',
              html.split('<body>', 1)[1], flags=re.S)
text = re.sub(r'<[^>]+>', ' ', body).replace('&nbsp;', ' ').replace('&amp;', '&')
missing = sorted({c for c in text if not c.isspace() and ord(c) not in cmap})
if missing:
    raise SystemExit(f'❌ 子集缺字，这些字会掉回系统字体：{"".join(missing)}')
print('    ✅ 全页零缺字')
PY

printf '==> 完成：%s（%s KB）\n' "$OUT" "$(( $(wc -c < "$OUT") / 1024 ))"
echo "    注意：Caddy 对 /assets/* 有 7 天强缓存。字形变了就把文件名的 .v2 递增，"
echo "    并同步改 landing/assets/css/landing.v2.css 的 @font-face 与 index.html 的 preload。"
