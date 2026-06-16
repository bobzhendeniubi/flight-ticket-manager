import { Link } from 'react-router-dom';
import { Seo } from '../components/Seo';
import { Breadcrumb } from '../components/Breadcrumb';
import { Icon, type IconName } from '../components/Icon';

/**
 * 关于我们 — 品牌介绍（世途旅行 / Citur Travel，澳门⇌岘港海岛专线）、
 * 「为什么选我们」、信任 / 资质块。Seo。
 *
 * 文案说明（make up）：品牌叙述基于已知事实（海岛专线、一价全包、中文客服）撰写，
 * 口吻与前台须知一致；资质 / 数字凡未确认处明确标注 placeholder，避免对外失实承诺。
 */

interface Reason {
  icon: IconName;
  title: string;
  desc: string;
}

const REASONS: Reason[] = [
  {
    icon: 'package',
    title: '一价全包，省心',
    desc: '机票 + 酒店 + 签证 + 地面服务整体打包，一个价格搞定海岛度假，不用逐项比价、来回拼凑。',
  },
  {
    icon: 'mapPin',
    title: '专注一条线，专业',
    desc: '只做澳门⇌岘港海岛专线，对航班、酒店、签证流程熟门熟路，能给到更贴合的行程建议。',
  },
  {
    icon: 'support',
    title: '中文客服全程在线',
    desc: '从下单、办签到落地接送，工作时间内中文客服随时响应，出行有问题不抓瞎。',
  },
  {
    icon: 'shield',
    title: '透明须知，无套路',
    desc: '退改、扣损规则在下单前逐条写清楚，价格提交后锁定，按章办事不玩文字游戏。',
  },
];

interface TrustItem {
  icon: IconName;
  label: string;
  value: string;
}

const TRUST: TrustItem[] = [
  { icon: 'shield', label: '经营资质', value: '正规旅行社（牌照号待补 placeholder）' },
  { icon: 'plane', label: '主营线路', value: '澳门 ⇌ 岘港海岛专线' },
  { icon: 'gift', label: '套餐内含', value: '机票 + 酒店 + 签证 + 地面服务' },
  { icon: 'support', label: '客服支持', value: '中文客服 · 工作时间在线' },
];

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-4xl">
      <Seo
        title="关于我们"
        description="世途旅行 · Citur Travel — 澳门⇌岘港海岛专线，专注机票+酒店+签证+地面服务一价全包的海岛度假。"
        canonicalPath="/about"
      />

      <Breadcrumb items={[{ label: '首页', to: '/' }, { label: '关于我们' }]} />

      {/* Hero */}
      <header className="mt-4 overflow-hidden rounded-3xl border border-slate-200/80 bg-gradient-to-br from-brand-600 to-brand-800 p-8 text-white shadow-lift md:p-12">
        <span className="badge bg-white/15 text-white backdrop-blur">
          <Icon name="mapPin" className="h-3.5 w-3.5" />
          澳门 ⇌ 岘港 海岛专线
        </span>
        <h1 className="mt-4 text-3xl font-extrabold tracking-tight md:text-4xl">世途旅行 · Citur Travel</h1>
        <p className="mt-3 max-w-2xl text-base leading-relaxed text-white/90 md:text-lg">
          我们把海岛度假这件事做简单：机票、酒店、签证、地面服务一价全包，明码标价、须知透明、客服在线。
          让你只管享受海岛阳光，繁琐的预订交给我们。
        </p>
      </header>

      {/* 品牌故事 */}
      <section className="mt-10">
        <h2 className="section-title text-xl">我们是谁</h2>
        <div className="section-sub space-y-3 text-base leading-relaxed text-ink-soft">
          <p>
            世途旅行（Citur Travel）专注澳门⇌岘港海岛专线，为出行者提供机票 + 酒店 + 签证 + 地面服务的一站式打包预订。
            相比东拼西凑地分别预订，我们用一个套餐价覆盖整段行程，省下比价和协调的精力。
          </p>
          <p>
            因为只深耕这一条线，我们对航班时刻、酒店选择、签证办理节奏更有把握，也更清楚旅客在每个环节真正在意什么——
            干净的海景房、靠谱的落地接送、看得懂的退改规则。
          </p>
        </div>
      </section>

      {/* 为什么选我们 */}
      <section className="mt-10">
        <h2 className="section-title text-xl">为什么选我们</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {REASONS.map((r) => (
            <article key={r.title} className="card">
              <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-50 text-brand">
                <Icon name={r.icon} className="h-5 w-5" />
              </span>
              <h3 className="mt-3 text-base font-bold text-ink">{r.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">{r.desc}</p>
            </article>
          ))}
        </div>
      </section>

      {/* 信任 / 资质 */}
      <section className="mt-10">
        <h2 className="section-title text-xl">信任与资质</h2>
        <p className="section-sub">以下为基本信息，标注「待补」的项目将随资质核验逐步公示。</p>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2">
          {TRUST.map((t) => (
            <div
              key={t.label}
              className="flex items-start gap-3 rounded-2xl border border-slate-200/70 bg-surface p-4 shadow-card"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand">
                <Icon name={t.icon} className="h-5 w-5" />
              </span>
              <div>
                <dt className="text-xs font-semibold text-ink-muted">{t.label}</dt>
                <dd className="mt-0.5 text-sm font-bold text-ink">{t.value}</dd>
              </div>
            </div>
          ))}
        </dl>
      </section>

      {/* CTA */}
      <section className="mt-12 rounded-3xl border border-slate-200/80 bg-gradient-to-br from-brand-50/60 to-surface p-6 text-center md:p-8">
        <h2 className="section-title text-xl">准备好出发了吗？</h2>
        <p className="section-sub mx-auto max-w-md">浏览海岛套餐，或有疑问先找客服，我们帮你规划行程。</p>
        <div className="mt-5 flex flex-wrap justify-center gap-3">
          <Link to="/" className="btn-primary text-sm">
            <Icon name="package" className="h-4 w-4" />
            浏览海岛套餐
          </Link>
          <Link to="/contact" className="btn-secondary text-sm">
            <Icon name="phone" className="h-4 w-4" />
            联系我们
          </Link>
          <Link to="/help" className="btn-ghost text-sm">
            <Icon name="support" className="h-4 w-4" />
            帮助中心
          </Link>
        </div>
      </section>
    </div>
  );
}
