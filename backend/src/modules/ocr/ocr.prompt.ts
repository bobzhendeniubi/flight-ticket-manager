/**
 * 护照 OCR 提示词（Qwen-VL，OpenAI 兼容 chat/completions：一条 user 消息 = 本提示词 + 护照图）。
 *
 * 单独成模块：路由、单测与基准脚本用的是同一份文本。
 *
 * 两条硬约束（都是线上踩过的坑，改提示词前先读）：
 *  1. **不写任何会被照抄的具体示例值**（真实地名 / 机关名 / 姓名 / 号码）。旧版给签发地点写了示例
 *     「如"广东省广州市"」，实测近 30 天 6408 位乘客里有 1076 位的签发地点恰好就是这个值——
 *     模型拿不准时直接抄示例，外省旅客全错。要说明格式只用占位描述（如「中文省份名」）。
 *  2. **签发地点 ≠ 签发机关**。旧版把二者写成「签发地点/签发机关文本」，约 930 位被填成了机关名。
 *     签发地点会进 PNR 导出、全岗总表、送签 / 票务模板，必须是护照「签发地点」栏的原文。
 *  后处理（ocr.postprocess.ts）另有确定性兜底，不单靠提示词。
 */
export const PASSPORT_OCR_PROMPT = [
  '你是护照 OCR 引擎。严格输出 JSON，不要任何注释或 markdown 代码块。',
  '字段：lastName, firstName, fullName, chineseName, documentNumber, ',
  'dateOfBirth(YYYY-MM-DD), gender(必须识别，只输出 M/F/X 之一：男=M 女=F 无法判定=X), ',
  'nationality(ISO-3166 alpha-3), ',
  'passportIssueCountry(ISO-3166 alpha-3), passportExpiry(YYYY-MM-DD), ',
  'passportIssueDate(YYYY-MM-DD), passportIssuePlace, placeOfBirth。',
  'passportIssuePlace 是护照「签发地点/Place of issue」这一栏印的文字：',
  '中国护照这一栏印成「中文省份名/省份拼音」，只输出斜杠前的中文，逐字照抄，',
  '不要自己加「省」「市」，也不要补城市名；港澳或外国护照有这一栏就按印刷原文输出；',
  '护照上没有这一栏或看不清就填 null。',
  '签发地点不是「签发机关/Authority」栏：签发机关印的是发证部门名称，绝不能填进 passportIssuePlace。',
  'placeOfBirth 是「出生地点/Place of birth」这一栏印的文字，中国护照同样只输出斜杠前的中文。',
  '另外输出 mrzLine1、mrzLine2：护照底部机读区(MRZ)两行原文，逐字符抄录（含填充符 <，每行 44 字符），',
  '无法读到机读区则填 null。',
  '再输出 fieldConfidence：一个对象，键为上述各字段名，值为 0-100 的整数识别置信度（越高越确信）。',
  '性别识别：优先读 MRZ 第二行第 21 位（M/F）；MRZ 缺失或模糊时读目视区「性别/Sex」栏（男/M→M，女/F→F）。',
  '找不到的字段填 null。优先用 MRZ 机读区提取机读字段，中文姓名/签发日期/签发地点/出生地用目视区。',
].join('');
