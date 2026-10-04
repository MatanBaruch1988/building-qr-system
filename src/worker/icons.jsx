
// Small inline icons. Decorative: every one is aria-hidden, meaning always comes from nearby text.
const Svg = ({ size = 24, children, ...rest }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
    {children}
  </svg>
)

export const IconCheck = (p) => <Svg {...p}><path d="M5 12.5l4.5 4.5L19 7.5" /></Svg>
export const IconCloudOff = (p) => (
  <Svg {...p}><path d="M3 3l18 18" /><path d="M17.5 17.5H7a4.5 4.5 0 0 1-1-8.9M9.2 5.5A6 6 0 0 1 20 10.5a4 4 0 0 1 1.2 6.4" /></Svg>
)
export const IconPinOff = (p) => (
  <Svg {...p}><path d="M3 3l18 18" /><path d="M9.5 4.6A6.5 6.5 0 0 1 18.6 12c0 1.5-.7 3-1.6 4.4M12 21s-6.5-6-6.5-10.5c0-.7.1-1.3.3-1.9" /><circle cx="12" cy="10" r="2" /></Svg>
)
export const IconAlert = (p) => (
  <Svg {...p}><path d="M12 3.5l9 16H3l9-16z" /><path d="M12 10v4.5M12 17.5v.01" /></Svg>
)
export const IconInfo = (p) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8v.01" /></Svg>
export const IconPin = (p) => (
  <Svg {...p}><path d="M12 21s-6.5-6-6.5-10.5a6.5 6.5 0 0 1 13 0C18.5 15 12 21 12 21z" /><circle cx="12" cy="10.5" r="2.2" /></Svg>
)
export const IconUser = (p) => <Svg {...p}><circle cx="12" cy="8" r="3.6" /><path d="M4.5 20c.8-3.9 3.8-6 7.5-6s6.7 2.1 7.5 6" /></Svg>
export const IconGlobe = (p) => (
  <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.6 2.6 3.9 5.6 3.9 9s-1.3 6.4-3.9 9c-2.6-2.6-3.9-5.6-3.9-9S9.4 5.6 12 3z" /></Svg>
)
export const IconEye = (p) => <Svg {...p}><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" /><circle cx="12" cy="12" r="2.8" /></Svg>
export const IconEyeOff = (p) => (
  <Svg {...p}><path d="M3 3l18 18" /><path d="M10.6 5.7A9.6 9.6 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-3.1 3.9M6.6 7.4A17 17 0 0 0 2 12s3.6 6.5 10 6.5a9.7 9.7 0 0 0 4.1-.9M9.9 9.9a3 3 0 0 0 4.2 4.2" /></Svg>
)
export const IconChevron = (p) => <Svg {...p}><path d="M9 6l6 6-6 6" /></Svg>
export const IconQr = (p) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="6" height="6" rx="1" /><rect x="14.5" y="3.5" width="6" height="6" rx="1" />
    <rect x="3.5" y="14.5" width="6" height="6" rx="1" /><path d="M14.5 14.5h2.5v2.5h-2.5zM19 14.5v.01M14.5 19.5v.01M17.5 19.5H20.5V17" />
  </Svg>
)
export const IconRefresh = (p) => (
  <Svg {...p}><path d="M20 11a8 8 0 0 0-14.5-4M4 4v4h4M4 13a8 8 0 0 0 14.5 4M20 20v-4h-4" /></Svg>
)
export const IconX = (p) => <Svg {...p}><path d="M6 6l12 12M18 6L6 18" /></Svg>
export const IconLock =(p) => (
  <Svg {...p}><rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></Svg>
)
export const IconSend =(p) => <Svg {...p}><path d="M21 3L10 14M21 3l-6.5 18-3.5-7.5L3.5 10 21 3z" /></Svg>
