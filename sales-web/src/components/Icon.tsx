/**
 * 统一线性图标集（lucide 风格，stroke=currentColor）。
 * 取代前台散落的 emoji —— emoji 跨平台渲染不一致、显廉价/AI 感；
 * 这里用一套一致的描边图标，尺寸跟随 className（默认 1em 级），颜色继承 currentColor。
 *
 * 用法：<Icon name="hotel" className="h-4 w-4 text-brand" />
 */
import type { SVGProps } from 'react';

export type IconName =
  | 'package'
  | 'hotel'
  | 'car'
  | 'visa'
  | 'support'
  | 'calendar'
  | 'plane'
  | 'planeDepart'
  | 'planeReturn'
  | 'mapPin'
  | 'sparkles'
  | 'search'
  | 'cart'
  | 'user'
  | 'menu'
  | 'check'
  | 'arrowRight'
  | 'star'
  | 'clock'
  | 'info'
  | 'shield'
  | 'gift'
  | 'phone'
  | 'ticket'
  | 'bed';

// 每个图标的子元素（统一 24×24，fill=none、stroke 由外层控制）
const PATHS: Record<IconName, JSX.Element> = {
  package: (
    <>
      <path d="m7.5 4.27 9 5.15" />
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="m3.3 7 8.7 5 8.7-5" />
      <path d="M12 22V12" />
    </>
  ),
  gift: (
    <>
      <rect x="3" y="8" width="18" height="4" rx="1" />
      <path d="M12 8v13" />
      <path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" />
      <path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8" />
      <path d="M16.5 8a2.5 2.5 0 0 0 0-5C13 3 12 8 12 8" />
    </>
  ),
  hotel: (
    <>
      <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" />
      <path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
      <path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2" />
      <path d="M10 6h4M10 10h4M10 14h4M10 18h4" />
    </>
  ),
  bed: (
    <>
      <path d="M2 4v16" />
      <path d="M2 8h18a2 2 0 0 1 2 2v10" />
      <path d="M2 17h20" />
      <path d="M6 8v4" />
    </>
  ),
  car: (
    <>
      <path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2" />
      <circle cx="7" cy="17" r="2" />
      <path d="M9 17h6" />
      <circle cx="17" cy="17" r="2" />
    </>
  ),
  visa: (
    <>
      <path d="M20 13c0 5-3.5 7.5-7.7 8.9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1 1 0 0 1 1.5 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  shield: (
    <path d="M20 13c0 5-3.5 7.5-7.7 8.9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1 1 0 0 1 1.5 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z" />
  ),
  support: (
    <path d="M3 14h2a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H4a1 1 0 0 1-1-1v-6a9 9 0 0 1 18 0v6a1 1 0 0 1-1 1h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h2" />
  ),
  phone: (
    <path d="M13.8 21a2 2 0 0 0 2-1.7l.3-2a2 2 0 0 0-1.1-2.1l-1.9-.9a2 2 0 0 0-2.3.5l-.5.6a12 12 0 0 1-4.2-4.2l.6-.5a2 2 0 0 0 .5-2.3l-.9-1.9A2 2 0 0 0 4.7 5l-2 .3A2 2 0 0 0 1 7.2 16 16 0 0 0 13.8 21z" />
  ),
  calendar: (
    <>
      <path d="M8 2v4M16 2v4M3 10h18" />
      <rect x="3" y="4" width="18" height="18" rx="2" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  plane: (
    <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3.5c-.5-.5-2.5 0-4 1.5L13.5 8.5 5.3 6.7c-.6-.1-1.1.1-1.4.5l-.7.9 5.5 3.5-3 3H3l-1 1.5 4 1.5 1.5 4L9 22l.5-2.5 3-3 3.5 5.5.9-.7c.4-.3.6-.8.5-1.4z" />
  ),
  planeDepart: (
    <>
      <path d="M2 22h20" />
      <path d="M3.8 13.6 2.5 9.2a1 1 0 0 1 1.3-1.2l2 .8 2.4-2.9 1.6.6-1.2 3.2 4.1 1.5 2.2-2.6a1 1 0 0 1 1.6.2l.7 1.4-13.2 4.8a1 1 0 0 1-1.3-.6z" />
    </>
  ),
  planeReturn: (
    <>
      <path d="M2 22h20" />
      <path d="M20.2 13.6 21.5 9.2a1 1 0 0 0-1.3-1.2l-2 .8-2.4-2.9-1.6.6 1.2 3.2-4.1 1.5-2.2-2.6a1 1 0 0 0-1.6.2l-.7 1.4 13.2 4.8a1 1 0 0 0 1.3-.6z" />
    </>
  ),
  ticket: (
    <>
      <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z" />
      <path d="M13 5v2M13 17v2M13 11v2" />
    </>
  ),
  mapPin: (
    <>
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </>
  ),
  sparkles: (
    <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z" />
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  cart: (
    <>
      <circle cx="8" cy="21" r="1" />
      <circle cx="19" cy="21" r="1" />
      <path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  check: <path d="M20 6 9 17l-5-5" />,
  arrowRight: (
    <>
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  star: <path d="M12 2.5 14.9 8.6l6.6.9-4.8 4.7 1.1 6.6L12 17.7 6.2 20.8l1.1-6.6L2.5 9.5l6.6-.9z" />,
};

// star 用实心填充，其余描边
const FILLED: ReadonlySet<IconName> = new Set<IconName>(['star']);

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
}

export function Icon({ name, className = 'h-4 w-4', ...rest }: IconProps) {
  const filled = FILLED.has(name);
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}
