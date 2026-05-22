// AUTO-GENERATED from docs/finances/COSTS.xlsx by scripts/build-presentation/build_costs_json.py
// 修改 COSTS.xlsx 后跑：
//   python3 scripts/build-presentation/build_costs_json.py
// 然后 commit + redeploy backend。

export interface CostCategory { label: string; usd: number; note: string; }
export interface CostDetailRow {
  isSection: boolean;
  label?: string;
  date?: string;
  category?: string;
  vendor?: string;
  usd?: number;
  what?: string;
  hours?: string;
}
export interface MonthlyForecastRow {
  category: string;
  testing: number;
  beta: number;
  stable: number;
  note: string;
}
export interface UnitEconStage {
  stage: string;
  orders: number;
  aovCny: number;
  gmvCny: number;
  profitCny: number;
  profitUsd: number;
}

export interface CostsData {
  asOf: string;
  title: string;
  totalUsd: number;
  categories: CostCategory[];
  detail: { rows: CostDetailRow[]; totalUsd: number; };
  monthly: {
    rows: MonthlyForecastRow[];
    totals: { testing: number; beta: number; stable: number; };
  };
  unitEcon: { stages: UnitEconStage[]; };
}

export const COSTS_DATA: CostsData = {
  "asOf": "2026-05-20",
  "title": "开发期已花成本（项目 2026-04 启动）",
  "totalUsd": 7334.0,
  "categories": [
    {
      "label": "开发外包",
      "usd": 6700.0,
      "note": "7 周外包开发（4 月 7 期 + 5 月 3 期）：MVP 脚手架 / 订单核心 / 代理产品 / 动态定价 / AI 助手 / 演示包 / 反馈迭代"
    },
    {
      "label": "Claude Code",
      "usd": 130.0,
      "note": "开发主力 AI 工具：Anthropic API token 用量（4 月 $50 + 5 月 $80）"
    },
    {
      "label": "OpenAI / 模型测试",
      "usd": 130.0,
      "note": "AI 助手内嵌的模型调用 + Prompt 迭代调试（4 月 $100 + 5 月 $30）"
    },
    {
      "label": "服务器（阿里云 HK）",
      "usd": 64.0,
      "note": "4C8G 轻量实例 $32/月 × 2 期（4 月 + 5 月）"
    },
    {
      "label": "域名 + DNS",
      "usd": 50.0,
      "note": "citur.com 试注 + 备用 .cn 域名 + Cloudflare 免费层 DNS"
    },
    {
      "label": "GitHub / CI",
      "usd": 40.0,
      "note": "Actions 分钟数（CI 流水线 ~30k 分钟）"
    },
    {
      "label": "设计素材",
      "usd": 80.0,
      "note": "Figma Pro 1 个月 + Iconify 图标一次性"
    },
    {
      "label": "杂项",
      "usd": 140.0,
      "note": "Unsplash CDN + Google Fonts 商用授权 + 越南语人工校对"
    }
  ],
  "detail": {
    "rows": [
      {
        "isSection": true,
        "label": "═══ 2026-04：项目启动 + MVP + AI 助手 ═══"
      },
      {
        "isSection": false,
        "date": "2026-04-02",
        "category": "开发外包",
        "vendor": "Phase 1 MVP",
        "usd": 800.0,
        "what": "monorepo 脚手架（backend/sales-web/admin-web/miniprogram）+ Prisma schema + JWT/RBAC 4 角色 + 微信 stub",
        "hours": "~50h"
      },
      {
        "isSection": false,
        "date": "2026-04-09",
        "category": "开发外包",
        "vendor": "Phase 1 订单核心",
        "usd": 900.0,
        "what": "Order/OrderItem/Passenger 模型 + 13 状态机 + 航班搜索 + 座位库存 CAS + 退款报价",
        "hours": "~55h"
      },
      {
        "isSection": false,
        "date": "2026-04-15",
        "category": "开发外包",
        "vendor": "Phase 1 代理+产品",
        "usd": 850.0,
        "what": "3 级代理层级 + 佣金分账 + Hotels/Transfers/Visas/Bundles CRUD",
        "hours": "~50h"
      },
      {
        "isSection": false,
        "date": "2026-04-18",
        "category": "服务器",
        "vendor": "阿里云 HK",
        "usd": 32.0,
        "what": "4C8G 轻量实例首月（包月 $32）",
        "hours": ""
      },
      {
        "isSection": false,
        "date": "2026-04-19",
        "category": "域名",
        "vendor": "Namecheap + 阿里云",
        "usd": 50.0,
        "what": "citur.com 试注 + 备用 .cn 域名 + Cloudflare 免费层 DNS",
        "hours": ""
      },
      {
        "isSection": false,
        "date": "2026-04-22",
        "category": "开发外包",
        "vendor": "Phase 2 动态定价",
        "usd": 800.0,
        "what": "动态定价引擎：DateRanking A/B/C/D × 余位 18 buckets；PricingService；结算单 + 月度报表",
        "hours": "~50h"
      },
      {
        "isSection": false,
        "date": "2026-04-25",
        "category": "开发外包",
        "vendor": "Phase 2 AI 助手",
        "usd": 1000.0,
        "what": "AI 助手 v1：5 个 tool（search_flights/hotels/transfers/visas/bundles）+ propose_order + 多轮对话循环",
        "hours": "~60h"
      },
      {
        "isSection": false,
        "date": "2026-04-26",
        "category": "OpenAI",
        "vendor": "OpenAI API",
        "usd": 100.0,
        "what": "AI 助手 Prompt 迭代 + GPT-5-mini vs Claude Sonnet 对比 + tool-use 调试",
        "hours": ""
      },
      {
        "isSection": false,
        "date": "2026-04-27",
        "category": "杂项",
        "vendor": "Unsplash + Google Fonts",
        "usd": 60.0,
        "what": "酒店/接送/签证产品图（25 张 hero）+ Inter / Noto Sans 商用授权",
        "hours": ""
      },
      {
        "isSection": false,
        "date": "2026-04-28",
        "category": "设计",
        "vendor": "Figma + Iconify",
        "usd": 80.0,
        "what": "Figma Pro 1 个月 + 一些图标包（一次性买断）",
        "hours": ""
      },
      {
        "isSection": false,
        "date": "2026-04-28",
        "category": "开发外包",
        "vendor": "Phase 2 演示准备",
        "usd": 750.0,
        "what": "小程序 (Taro 4.0.9) + 微信支付 sandbox + i18n 完善 + Demo seed 6 单 + 演示包",
        "hours": "~45h"
      },
      {
        "isSection": false,
        "date": "2026-04-29",
        "category": "GitHub",
        "vendor": "GitHub Actions",
        "usd": 40.0,
        "what": "CI 流水线（lint/test/build/docker push）~30k 分钟",
        "hours": ""
      },
      {
        "isSection": false,
        "date": "2026-04-29",
        "category": "杂项",
        "vendor": "人工翻译",
        "usd": 80.0,
        "what": "越南语 + 英语 i18n 文案人工校对",
        "hours": ""
      },
      {
        "isSection": false,
        "date": "2026-04-29",
        "category": "Claude Code",
        "vendor": "Anthropic API",
        "usd": 50.0,
        "what": "Claude Code 试用期 token 用量（开发主力工具）",
        "hours": ""
      },
      {
        "isSection": true,
        "label": "═══ 2026-05：反馈驱动迭代 ═══"
      },
      {
        "isSection": false,
        "date": "2026-05-05",
        "category": "开发外包",
        "vendor": "M2 完善",
        "usd": 400.0,
        "what": "M2 路由表 + 跨域代理 RBAC + agents.routes 完整覆盖 + 演示包 docx/pptx 生成脚本",
        "hours": "~25h"
      },
      {
        "isSection": false,
        "date": "2026-05-13",
        "category": "开发外包",
        "vendor": "小程序修复",
        "usd": 300.0,
        "what": "小程序 build 通：webpack@5.91 pin + Node 22 兼容 + dev.ts 指 staging + Taro 配置修",
        "hours": "~18h"
      },
      {
        "isSection": false,
        "date": "2026-05-13",
        "category": "服务器",
        "vendor": "阿里云 HK",
        "usd": 32.0,
        "what": "第 2 月（4-5 月共 $64）",
        "hours": ""
      },
      {
        "isSection": false,
        "date": "2026-05-14",
        "category": "OpenAI",
        "vendor": "OpenAI API",
        "usd": 30.0,
        "what": "测试 staging AI 调用（地区屏蔽前的小额）",
        "hours": ""
      },
      {
        "isSection": false,
        "date": "2026-05-14",
        "category": "Claude Code",
        "vendor": "Anthropic API",
        "usd": 80.0,
        "what": "5 月 Claude Code token 用量（持续开发用）",
        "hours": ""
      },
      {
        "isSection": false,
        "date": "2026-05-20",
        "category": "开发外包",
        "vendor": "反馈 wave 1",
        "usd": 900.0,
        "what": "PNR Excel 导出 / 护照 zip 打包 / 待办系统 / 17 字段扩展 / 拼房 endpoint / claim 接单",
        "hours": "~55h"
      },
      {
        "isSection": true,
        "label": "═══ 合计 ═══"
      }
    ],
    "totalUsd": 0
  },
  "monthly": {
    "rows": [
      {
        "category": "AI / Token",
        "testing": 35.0,
        "beta": 550.0,
        "stable": 3500.0,
        "note": "对话量×单价；A: 50-200/天 ｜ B: 500-1500/天 ｜ C: 3000-8000/天"
      },
      {
        "category": "服务器",
        "testing": 32.0,
        "beta": 100.0,
        "stable": 250.0,
        "note": "阿里云 HK 4C8G → 8C16G + 备份机 → 主从 + worker"
      },
      {
        "category": "数据库（独立 RDS）",
        "testing": 0.0,
        "beta": 50.0,
        "stable": 150.0,
        "note": "B 起独立 4G；C 主从 + 自动备份"
      },
      {
        "category": "CDN（Cloudflare）",
        "testing": 0.0,
        "beta": 20.0,
        "stable": 100.0,
        "note": "免费 → Pro $20 → Business $200，按流量分级"
      },
      {
        "category": "邮件 / 短信",
        "testing": 0.0,
        "beta": 100.0,
        "stable": 600.0,
        "note": "阿里云通信 / Twilio 按量计费"
      },
      {
        "category": "监控（Sentry + 日志）",
        "testing": 0.0,
        "beta": 30.0,
        "stable": 100.0,
        "note": "Team plan + 日志聚合"
      },
      {
        "category": "其他（域名/SSL/备份）",
        "testing": 5.0,
        "beta": 20.0,
        "stable": 50.0,
        "note": "域名续费、SSL 免费、备份外发"
      }
    ],
    "totals": {
      "testing": 72.0,
      "beta": 870.0,
      "stable": 4750.0
    }
  },
  "unitEcon": {
    "stages": [
      {
        "stage": "公测期",
        "orders": 100,
        "aovCny": 3500.0,
        "gmvCny": 350000.0,
        "profitCny": 28000.0,
        "profitUsd": 3920.0
      },
      {
        "stage": "稳定期",
        "orders": 1000,
        "aovCny": 3800.0,
        "gmvCny": 3800000.0,
        "profitCny": 304000.0,
        "profitUsd": 42560.0
      },
      {
        "stage": "规模化",
        "orders": 5000,
        "aovCny": 4000.0,
        "gmvCny": 20000000.0,
        "profitCny": 1600000.0,
        "profitUsd": 224000.0
      },
      {
        "stage": "公测期",
        "orders": 3920,
        "aovCny": 870.0,
        "gmvCny": 4.50574712643678,
        "profitCny": 0.08,
        "profitUsd": 0.0
      },
      {
        "stage": "稳定期",
        "orders": 42560,
        "aovCny": 4750.0,
        "gmvCny": 8.96,
        "profitCny": 0.08,
        "profitUsd": 0.0
      },
      {
        "stage": "规模化",
        "orders": 224000,
        "aovCny": 7125.0,
        "gmvCny": 31.4385964912281,
        "profitCny": 0.08,
        "profitUsd": 0.0
      }
    ]
  }
} as const;
