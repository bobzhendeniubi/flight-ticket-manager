import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Seo } from '../components/Seo';
import { Breadcrumb } from '../components/Breadcrumb';
import { EmptyState } from '../components/EmptyState';
import { Icon, type IconName } from '../components/Icon';

/**
 * 帮助中心（E2）— 可搜索 + 锚点定位的 FAQ，按 支付/下单/签证/退改/酒店/机票/接送/查订单 分组，
 * 用 accordion（<details>/disclosure）逐条展开；底部「联系我们」块。
 *
 * 文案说明（make up）：问答内容是结合 lib/notices.ts 里运营确认的预订须知 / 扣损规则
 * 「make sense」润色而成，口吻与下单时的须知一致，不引入与既有政策矛盾的新承诺；
 * 退改/扣损的具体数字沿用须知里运营定的标准。电话/微信/邮箱为占位，待运营补真值。
 */

interface Faq {
  q: string;
  a: string;
}

interface FaqGroup {
  id: string;
  title: string;
  icon: IconName;
  faqs: Faq[];
}

// 占位客服信息 —— 待运营补真值（placeholder）
const SUPPORT = {
  phone: '+853 0000 0000（待补）',
  wechat: 'citur-travel（待补）',
  email: 'support@citurtravel.example（待补）',
  hours: '每天 09:00 – 21:00（节假日顺延，待运营确认）',
};

const FAQ_GROUPS: FaqGroup[] = [
  {
    id: 'payment',
    title: '支付',
    icon: 'shield',
    faqs: [
      {
        q: '支持哪些付款方式？',
        a: '下单后可在订单页查看收款方式并完成付款。付款后请保留付款凭证，运营会在工作时间内人工核对到账并确认订单；如长时间未确认，可凭订单号联系客服催办。',
      },
      {
        q: '为什么我付了款订单还显示「待支付」？',
        a: '到账核对为人工确认，存在短暂延迟属正常。请稍候并保留付款截图；若超过预计时间仍未更新，请通过「联系我们」凭订单号反馈，我们会优先处理。',
      },
      {
        q: '价格会变吗？',
        a: '套餐为机票 + 酒店 + 签证 + 接送整体打包价（页面按每人价展示，默认 2 人 1 间）。最终以下单时确认的订单金额为准；提交后金额锁定，不受后续库存价格波动影响。',
      },
    ],
  },
  {
    id: 'booking',
    title: '下单',
    icon: 'package',
    faqs: [
      {
        q: '不注册可以下单吗？',
        a: '可以。前台支持免登录下单，下单后请记好订单号；之后可在「查询订单」凭订单号 + 姓氏（Last name）查看订单状态，无需账号。',
      },
      {
        q: '出行人姓名 / 护照怎么填？',
        a: '请确保出行人姓名与护照完全一致，护照有效期需距回程日期 6 个月以上，否则可能无法出入境。资料填错可能影响出票，请仔细核对。',
      },
      {
        q: '有特殊需求（床型、餐食等）怎么备注？',
        a: '请把偏好写在订单的「特殊说明 / 备注」里，例如床型（大床 / 双床）、相邻房间等。我们会尽量安排，最终以酒店当日实际为准。',
      },
      {
        q: '套餐里某一项我不用，能退差价吗？',
        a: '套餐为整体打包优惠，机票、酒店、签证、接送任一单项自愿放弃使用，均不退差价。',
      },
    ],
  },
  {
    id: 'visa',
    title: '签证',
    icon: 'visa',
    faqs: [
      {
        q: '签证大概多久能办好？',
        a: '签证办理一般需 3 个工作日左右。建议至少提前 7 天预订并提交护照资料，以免影响出行。',
      },
      {
        q: '办签需要准备什么？',
        a: '通常需要护照首页清晰照片等基本资料。下单后客服会告知所需材料清单；请按要求提交，资料齐全可加快办理。',
      },
    ],
  },
  {
    id: 'refund',
    title: '退改',
    icon: 'clock',
    faqs: [
      {
        q: '出行前被打包出境 / 被告知黑名单，怎么算？',
        a: '按运营确认的扣损标准执行：① 起飞前几天被打包出境（需提供打包证明）、且仍在销售期内，扣损 ¥500/人，其余费用退回；② 起飞当天 12:00 之前（或起飞前一天 12:00 以后）被打包或被告知黑名单，扣损 ¥800/人，其余退回；③ 起飞当天 12:00 之后被打包的，损失由客人自行承担。涉及周六日 / 节假日的销售期按假前最后一个工作日政策执行。',
      },
      {
        q: '遇到航班取消 / 大面积延误怎么办？',
        a: '如遇不可抗力（航班取消、大面积延误等），我们会协助免费改期，或按实际未发生的费用为您退款。',
      },
      {
        q: '机票可以只飞一程吗？',
        a: '机票须按航段顺序使用。未乘坐去程航段的，回程会被航司自动取消，请勿跳段使用。',
      },
    ],
  },
  {
    id: 'hotel',
    title: '酒店',
    icon: 'hotel',
    faqs: [
      {
        q: '酒店含早餐吗？',
        a: '套餐酒店含双人早餐。床型（大床 / 双床）可在订单备注写偏好，我们尽量安排，以酒店当日实际为准。',
      },
      {
        q: '一个人出行、想自己住一间房怎么算？',
        a: '套餐价按 2 人 1 间（双人同住）核算，显示为每人价。如果想一个人住一间房，下单时在套餐里直接选「单人入住（一人一间房）」，系统按每晚差价自动加到价格里，无需联系客服。',
      },
    ],
  },
  {
    id: 'flight',
    title: '机票',
    icon: 'plane',
    faqs: [
      {
        q: '应该提前多久到机场？',
        a: '国际航班建议提前 2.5–3 小时到达机场办理值机。值机柜台于起飞前约 50 分钟关闭，逾时无法办理。',
      },
      {
        q: '登机口什么时候开始登机？',
        a: '登机口一般于起飞前 30 分钟开始登机，请预留安检与通关时间，避免误机。',
      },
    ],
  },
  {
    id: 'transfer',
    title: '接送',
    icon: 'car',
    faqs: [
      {
        q: '套餐含接送机吗？',
        a: '海岛套餐含澳门免费接送机。具体上 / 下车点与时间，客服会在出行前与您确认。',
      },
    ],
  },
  {
    id: 'lookup',
    title: '查订单',
    icon: 'search',
    faqs: [
      {
        q: '没有账号怎么查订单？',
        a: '前往「查询订单」页，凭订单号 + 出行人姓氏（Last name）即可查看订单状态，无需登录。',
      },
      {
        q: '订单号忘了 / 查不到怎么办？',
        a: '请通过下方「联系我们」提供下单时填写的手机号或邮箱，客服可协助找回订单。',
      },
    ],
  },
];

/** 大小写不敏感的简单匹配（问题或答案命中即保留）。 */
function matchFaq(faq: Faq, kw: string): boolean {
  if (!kw) return true;
  const lower = kw.toLowerCase();
  return faq.q.toLowerCase().includes(lower) || faq.a.toLowerCase().includes(lower);
}

export default function HelpPage() {
  const [query, setQuery] = useState('');

  // 按搜索词过滤每组的 FAQ；组内无命中则整组隐藏
  const filteredGroups = useMemo(() => {
    const kw = query.trim();
    return FAQ_GROUPS.map((g) => ({
      ...g,
      faqs: g.faqs.filter((f) => matchFaq(f, kw)),
    })).filter((g) => g.faqs.length > 0);
  }, [query]);

  const hasResults = filteredGroups.length > 0;

  return (
    <div className="mx-auto max-w-4xl">
      <Seo
        title="帮助中心"
        description="常见问题、下单与退改流程、签证须知、查订单与联系客服。"
        canonicalPath="/help"
      />

      <Breadcrumb items={[{ label: '首页', to: '/' }, { label: '帮助中心' }]} />

      {/* 标题 + 搜索 */}
      <header className="mt-4">
        <h1 className="section-title text-2xl md:text-3xl">帮助中心</h1>
        <p className="section-sub">下单、支付、签证、退改…需要的答案都在这里。找不到？直接联系客服。</p>

        <div className="relative mt-5">
          <Icon
            name="search"
            className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-ink-muted"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索问题，例如「退改」「签证」「查订单」"
            aria-label="搜索常见问题"
            className="input py-3 pl-12 pr-4 text-base"
            enterKeyHint="search"
          />
        </div>
      </header>

      {/* 分类锚点（无搜索词时显示，点击跳到对应分组） */}
      {!query.trim() && (
        <nav aria-label="问题分类" className="mt-5 flex flex-wrap gap-2">
          {FAQ_GROUPS.map((g) => (
            <a
              key={g.id}
              href={`#help-${g.id}`}
              className="chip transition-colors hover:bg-brand-50 hover:text-brand-700"
            >
              <Icon name={g.icon} className="h-3.5 w-3.5" />
              {g.title}
            </a>
          ))}
        </nav>
      )}

      {/* FAQ 分组 + accordion */}
      <div className="mt-6 space-y-8">
        {hasResults ? (
          filteredGroups.map((group) => (
            <section key={group.id} id={`help-${group.id}`} className="scroll-mt-24">
              <h2 className="flex items-center gap-2 text-lg font-extrabold text-ink">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand">
                  <Icon name={group.icon} className="h-4 w-4" />
                </span>
                {group.title}
              </h2>
              <div className="mt-3 space-y-2.5">
                {group.faqs.map((faq, idx) => (
                  <details
                    key={idx}
                    className="group card-interactive p-0 [&_summary]:list-none"
                  >
                    <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3.5 text-sm font-semibold text-ink md:px-5">
                      <span>{faq.q}</span>
                      <Icon
                        name="arrowRight"
                        className="h-4 w-4 shrink-0 text-ink-muted transition-transform duration-200 group-open:rotate-90"
                      />
                    </summary>
                    <p className="border-t border-slate-200/70 px-4 py-3.5 text-sm leading-relaxed text-ink-soft md:px-5">
                      {faq.a}
                    </p>
                  </details>
                ))}
              </div>
            </section>
          ))
        ) : (
          <EmptyState
            icon="search"
            title="没有找到相关问题"
            hint="换个关键词试试，或直接联系客服，我们帮你解答。"
            action={
              <a href="#help-contact" className="btn-primary text-sm">
                联系客服
              </a>
            }
          />
        )}
      </div>

      {/* 联系我们块 */}
      <section
        id="help-contact"
        className="mt-12 scroll-mt-24 rounded-3xl border border-slate-200/80 bg-gradient-to-br from-brand-50/60 to-surface p-6 md:p-8"
      >
        <div className="flex flex-col gap-1.5">
          <h2 className="section-title text-xl">还没解决？联系我们</h2>
          <p className="section-sub">工作时间内人工回复，出行问题我们全程在线协助。</p>
        </div>

        <dl className="mt-5 grid gap-4 sm:grid-cols-3">
          <ContactItem icon="phone" label="客服电话" value={SUPPORT.phone} />
          <ContactItem icon="support" label="微信客服" value={SUPPORT.wechat} />
          <ContactItem icon="info" label="客服邮箱" value={SUPPORT.email} />
        </dl>

        <p className="mt-4 flex items-center gap-1.5 text-xs text-ink-muted">
          <Icon name="clock" className="h-3.5 w-3.5" />
          服务时间：{SUPPORT.hours}
        </p>

        <div className="mt-6 flex flex-wrap gap-3">
          <Link to="/contact" className="btn-primary text-sm">
            <Icon name="phone" className="h-4 w-4" />
            前往联系我们
          </Link>
          <Link to="/lookup" className="btn-secondary text-sm">
            <Icon name="search" className="h-4 w-4" />
            查询订单
          </Link>
        </div>
      </section>
    </div>
  );
}

function ContactItem({
  icon,
  label,
  value,
}: {
  icon: IconName;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200/70 bg-surface p-4 shadow-card">
      <dt className="flex items-center gap-1.5 text-xs font-semibold text-ink-muted">
        <Icon name={icon} className="h-3.5 w-3.5 text-brand" />
        {label}
      </dt>
      <dd className="mt-1.5 text-sm font-bold text-ink">{value}</dd>
    </div>
  );
}
