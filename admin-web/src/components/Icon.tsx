import type { SVGProps } from 'react';

export type IconName =
  | 'alert'
  | 'bolt'
  | 'building'
  | 'car'
  | 'calendar'
  | 'camera'
  | 'check'
  | 'chevronLeft'
  | 'chevronRight'
  | 'clipboard'
  | 'close'
  | 'download'
  | 'edit'
  | 'eye'
  | 'file'
  | 'gift'
  | 'handshake'
  | 'hotel'
  | 'info'
  | 'luggage'
  | 'list'
  | 'lock'
  | 'mail'
  | 'mapPin'
  | 'package'
  | 'pause'
  | 'phone'
  | 'plane'
  | 'play'
  | 'plus'
  | 'refresh'
  | 'settings'
  | 'ticket'
  | 'trash'
  | 'unlock'
  | 'upload'
  | 'user'
  | 'users'
  | 'visa'
  | 'wallet'
  | 'wheelchair';

const PATHS: Record<IconName, JSX.Element> = {
  alert: (
    <>
      <path d="M10.3 3.7 2.2 18a2 2 0 0 0 1.7 3h16.2a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  bolt: <path d="m13 2-8 12h6l-1 8 8-12h-6l1-8Z" />,
  building: (
    <>
      <path d="M4 21V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v17M16 9h2a2 2 0 0 1 2 2v10M2 21h20" />
      <path d="M8 6h4M8 10h4M8 14h4M8 18h4" />
    </>
  ),
  car: (
    <>
      <path d="M5 17h14l1-5-2-4H6l-2 4 1 5Z" />
      <path d="M4 12h16M7 17v2M17 17v2" />
      <circle cx="7" cy="14" r="1" />
      <circle cx="17" cy="14" r="1" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M8 2v4M16 2v4M3 10h18" />
    </>
  ),
  camera: (
    <>
      <path d="M4 7h3l1.5-2h7L17 7h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  chevronLeft: <path d="m15 5-7 7 7 7" />,
  chevronRight: <path d="m9 5 7 7-7 7" />,
  clipboard: (
    <>
      <rect x="5" y="4" width="14" height="18" rx="2" />
      <path d="M9 4.5V3h6v1.5M9 10h6M9 14h6M9 18h3" />
    </>
  ),
  close: <path d="m6 6 12 12M18 6 6 18" />,
  download: (
    <>
      <path d="M12 3v12M7 10l5 5 5-5M4 21h16" />
    </>
  ),
  edit: (
    <>
      <path d="m4 16-.8 4.8L8 20l11.7-11.7a2 2 0 0 0-2.8-2.8Z" />
      <path d="m15 6 3 3" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  file: (
    <>
      <path d="M6 2h8l4 4v16H6z" />
      <path d="M14 2v5h5M9 12h6M9 16h6" />
    </>
  ),
  gift: (
    <>
      <path d="M3 8h18v4H3zM5 12v9h14v-9M12 8v13" />
      <path d="M7.5 8a2.5 2.5 0 1 1 0-5C11 3 12 8 12 8M16.5 8a2.5 2.5 0 1 0 0-5C13 3 12 8 12 8" />
    </>
  ),
  handshake: (
    <>
      <path d="m3 11 4-4h4l2 2 2-2h3l3 3-4 4-3-2-2 2-3-3-4 4-2-2Z" />
      <path d="m7 15 2 2M10 14l3 3M14 13l2 2" />
    </>
  ),
  hotel: (
    <>
      <path d="M6 21V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v17M6 12H4a2 2 0 0 0-2 2v7M18 9h2a2 2 0 0 1 2 2v10M2 21h20" />
      <path d="M10 6h4M10 10h4M10 14h4M10 18h4" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  luggage: (
    <>
      <rect x="5" y="6" width="14" height="15" rx="2" />
      <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M9 10v7M15 10v7M3 10h2M19 10h2M8 21v1M16 21v1" />
    </>
  ),
  list: (
    <>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3 6h.01M3 12h.01M3 18h.01" />
    </>
  ),
  lock: (
    <>
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </>
  ),
  mapPin: (
    <>
      <path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </>
  ),
  package: (
    <>
      <path d="m7.5 4.3 9 5.1M21 8v8a2 2 0 0 1-1 1.7l-7 4a2 2 0 0 1-2 0l-7-4A2 2 0 0 1 3 16V8a2 2 0 0 1 1-1.7l7-4a2 2 0 0 1 2 0l7 4A2 2 0 0 1 21 8Z" />
      <path d="m3.3 7 8.7 5 8.7-5M12 22V12" />
    </>
  ),
  pause: <path d="M8 5v14M16 5v14" />,
  phone: <path d="M13.8 21a2 2 0 0 0 2-1.7l.3-2a2 2 0 0 0-1.1-2.1l-1.9-.9a2 2 0 0 0-2.3.5l-.5.6a12 12 0 0 1-4.2-4.2l.6-.5a2 2 0 0 0 .5-2.3l-.9-1.9A2 2 0 0 0 4.7 5l-2 .3A2 2 0 0 0 1 7.2 16 16 0 0 0 13.8 21Z" />,
  plane: (
    <>
      <path d="m3 15 7-3 3-8 2 .5-.5 7.5 6 2.5-1 2-6-1.5-3 5-2-.5 1-5.5-5.5 1Z" />
    </>
  ),
  play: <path d="m8 5 11 7-11 7V5Z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  refresh: <path d="M20 11a8 8 0 0 0-14.8-3L3 11M3 5v6h6M4 13a8 8 0 0 0 14.8 3L21 13M21 19v-6h-6" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-1.8 1.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5v.1h-2.6v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1-1.8-1.8.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H6.4v-2.6h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1 1.8-1.8.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5v-.1H15v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1 1.8 1.8-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.1V14h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </>
  ),
  ticket: (
    <>
      <path d="M3 8a3 3 0 0 0 0 6v3a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3a3 3 0 0 0 0-6V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2Z" />
      <path d="M13 3v3M13 12v3M13 18v1" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3" />
    </>
  ),
  unlock: (
    <>
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 7.5-2M12 14v3" />
    </>
  ),
  upload: (
    <>
      <path d="M12 15V3M7 8l5-5 5 5M4 21h16" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M2 21a7 7 0 0 1 14 0M16 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 4 5" />
    </>
  ),
  visa: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 10h18M7 15h4" />
    </>
  ),
  wallet: (
    <>
      <path d="M4 6.5V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2" />
      <path d="M4 6h15a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 1-2Z" />
      <path d="M16 14h.01" />
    </>
  ),
  wheelchair: (
    <>
      <circle cx="10" cy="4" r="2" />
      <path d="M10 8v5h5l2 4M10 13a6 6 0 1 0 5.7 8M10 8l5 1" />
    </>
  ),
};

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number | string;
}

export function Icon({ name, size = 16, className, ...rest }: IconProps) {
  return (
    <svg
      {...rest}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
