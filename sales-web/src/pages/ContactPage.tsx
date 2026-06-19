import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Seo } from '../components/Seo';
import { Breadcrumb } from '../components/Breadcrumb';
import { Icon, type IconName } from '../components/Icon';

/**
 * 联系我们 — 联系方式（电话 / 微信 / 邮箱 / 地址，均为占位 placeholder）、营业时间、
 * 一个纯前端联系表单（无后端：提交后弹友好确认），底部链到 /help 与 /lookup。Seo。
 *
 * 文案说明（make up）：所有联系方式为占位值，明确标注「待补」；待运营提供真实信息后替换。
 * 表单不连接后端，仅本地校验 + 成功态提示，避免给用户「已提交工单」的错觉
 * （文案明确引导用户改用电话 / 微信直达客服）。
 */

interface ContactMethod {
  icon: IconName;
  label: string;
  value: string;
  hint: string;
}

const METHODS: ContactMethod[] = [
  { icon: 'phone', label: '客服电话', value: '+853 0000 0000', hint: '工作时间内人工接听（号码待补）' },
  { icon: 'support', label: '微信客服', value: 'coco-holiday', hint: '加微信咨询、发资料更方便（微信号待补）' },
  { icon: 'info', label: '客服邮箱', value: 'support@cocoholiday.example', hint: '非紧急问题可邮件留言（邮箱待补）' },
  { icon: 'mapPin', label: '公司地址', value: '澳门（详细地址待补）', hint: '到访请提前预约' },
];

const HOURS: Array<{ days: string; time: string }> = [
  { days: '周一至周五', time: '09:00 – 21:00' },
  { days: '周六、周日', time: '10:00 – 18:00' },
  { days: '法定节假日', time: '值班客服（响应时间顺延）' },
];

export default function ContactPage() {
  const [submitted, setSubmitted] = useState(false);
  const [form, setForm] = useState({ name: '', contact: '', message: '' });

  const update = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((prev) => ({ ...prev, [key]: e.target.value }));

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    // 纯前端：不发请求，本地必填校验通过后直接进成功态
    if (!form.name.trim() || !form.contact.trim() || !form.message.trim()) return;
    setSubmitted(true);
  };

  const resetForm = () => {
    setForm({ name: '', contact: '', message: '' });
    setSubmitted(false);
  };

  return (
    <div className="mx-auto max-w-4xl">
      <Seo
        title="联系我们"
        description="椰岛假期客服渠道、营业时间与在线留言 —— 电话、微信、邮箱，出行问题全程协助。"
        canonicalPath="/contact"
      />

      <Breadcrumb items={[{ label: '首页', to: '/' }, { label: '联系我们' }]} />

      <header className="mt-4">
        <h1 className="section-title text-2xl md:text-3xl">联系我们</h1>
        <p className="section-sub">有任何关于下单、付款、签证或行程的问题，随时找我们。最快的方式是电话或微信直达客服。</p>
      </header>

      <div className="mt-8 grid gap-8 lg:grid-cols-5">
        {/* 联系方式 + 营业时间 */}
        <div className="space-y-6 lg:col-span-2">
          <section>
            <h2 className="section-title text-lg">联系方式</h2>
            <ul className="mt-3 space-y-3">
              {METHODS.map((m) => (
                <li
                  key={m.label}
                  className="flex items-start gap-3 rounded-2xl border border-slate-200/70 bg-surface p-4 shadow-card"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand">
                    <Icon name={m.icon} className="h-5 w-5" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-ink-muted">{m.label}</p>
                    <p className="text-sm font-bold text-ink">{m.value}</p>
                    <p className="mt-0.5 text-xs text-ink-soft">{m.hint}</p>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-2xl border border-slate-200/70 bg-canvas p-4">
            <h2 className="flex items-center gap-1.5 text-sm font-bold text-ink">
              <Icon name="clock" className="h-4 w-4 text-brand" />
              营业时间
            </h2>
            <dl className="mt-3 space-y-2 text-sm">
              {HOURS.map((h) => (
                <div key={h.days} className="flex items-center justify-between gap-3">
                  <dt className="text-ink-soft">{h.days}</dt>
                  <dd className="font-semibold text-ink nums">{h.time}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-xs text-ink-muted">具体时间以运营公布为准（待补）。</p>
          </section>
        </div>

        {/* 在线留言（纯前端） */}
        <section className="lg:col-span-3">
          <div className="card">
            <h2 className="section-title text-lg">在线留言</h2>
            <p className="section-sub">留下联系方式和问题，客服会在工作时间内回复。急事请直接电话或微信联系。</p>

            {submitted ? (
              <div className="mt-5 flex flex-col items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50/60 px-6 py-10 text-center">
                <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-600">
                  <Icon name="check" className="h-7 w-7" />
                </span>
                <h3 className="text-base font-bold text-ink">已收到您的留言，谢谢！</h3>
                <p className="mx-auto max-w-sm text-sm text-ink-soft">
                  客服会尽快与您联系。如较急，欢迎直接拨打客服电话或添加微信，我们会优先处理。
                </p>
                <button type="button" onClick={resetForm} className="btn-secondary mt-1 text-sm">
                  再写一条
                </button>
              </div>
            ) : (
              <form className="mt-5 space-y-4" onSubmit={onSubmit} noValidate>
                <div>
                  <label className="label" htmlFor="contact-name">
                    称呼 <span className="text-deal">*</span>
                  </label>
                  <input
                    id="contact-name"
                    className="input"
                    value={form.name}
                    onChange={update('name')}
                    placeholder="怎么称呼您"
                    autoComplete="name"
                    required
                  />
                </div>
                <div>
                  <label className="label" htmlFor="contact-way">
                    联系方式（电话 / 微信 / 邮箱） <span className="text-deal">*</span>
                  </label>
                  <input
                    id="contact-way"
                    className="input"
                    value={form.contact}
                    onChange={update('contact')}
                    placeholder="方便我们回复您的方式"
                    required
                  />
                </div>
                <div>
                  <label className="label" htmlFor="contact-msg">
                    您的问题 <span className="text-deal">*</span>
                  </label>
                  <textarea
                    id="contact-msg"
                    className="input min-h-[120px] resize-y"
                    value={form.message}
                    onChange={update('message')}
                    placeholder="想咨询的套餐、出行日期、人数，或遇到的问题…"
                    required
                  />
                </div>
                <p className="text-xs text-ink-muted">
                  提示：本表单仅作留言登记，不代表订单已提交。提交即表示同意我们通过上述方式与您联系。
                </p>
                <button type="submit" className="btn-primary w-full sm:w-auto">
                  <Icon name="arrowRight" className="h-4 w-4" />
                  提交留言
                </button>
              </form>
            )}
          </div>

          {/* 快捷入口 */}
          <div className="mt-5 flex flex-wrap gap-3">
            <Link to="/help" className="btn-secondary text-sm">
              <Icon name="support" className="h-4 w-4" />
              查看帮助中心
            </Link>
            <Link to="/lookup" className="btn-secondary text-sm">
              <Icon name="search" className="h-4 w-4" />
              查询订单
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
