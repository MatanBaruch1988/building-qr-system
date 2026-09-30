import React from 'react'
export {
  IconAlert, IconCheck, IconChevron, IconCloudOff, IconEye, IconEyeOff, IconGlobe, IconInfo, IconLock, IconPin,
  IconPinOff, IconQr, IconSend,
} from '../worker/icons.jsx'

const Svg = ({ size = 22, children, ...rest }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
    {children}
  </svg>
)

export const IconPlus = (p) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>
export const IconEdit = (p) => <Svg {...p}><path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" /></Svg>
export const IconPrinter = (p) => <Svg {...p}><path d="M7 9V4h10v5M7 17H5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2" /><rect x="7" y="14" width="10" height="6" rx="1" /></Svg>
export const IconDownload = (p) => <Svg {...p}><path d="M12 4v11M7.5 11L12 15.5 16.5 11M5 20h14" /></Svg>
export const IconCopy = (p) => <Svg {...p}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a1 1 0 0 1 1-1h9" /></Svg>
export const IconKey = (p) => <Svg {...p}><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M16 7l3 3M14 9l2 2" /></Svg>
export const IconUsers = (p) => <Svg {...p}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.2a6.5 6.5 0 0 1 3.5 5.8" /></Svg>
export const IconList = (p) => <Svg {...p}><path d="M8 6h12M8 12h12M8 18h12M4 6v.01M4 12v.01M4 18v.01" /></Svg>
export const IconShield = (p) => <Svg {...p}><path d="M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6l8-3z" /><path d="M9 12l2.2 2.2L15.5 10" /></Svg>
export const IconLogout = (p) => <Svg {...p}><path d="M10 4H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4M15 8l4 4-4 4M19 12H9" /></Svg>
export const IconRefresh = (p) => <Svg {...p}><path d="M20 11a8 8 0 0 0-14.5-4M4 4v4h4M4 13a8 8 0 0 0 14.5 4M20 20v-4h-4" /></Svg>
export const IconX = (p) => <Svg {...p}><path d="M6 6l12 12M18 6L6 18" /></Svg>
export const IconLocate = (p) => <Svg {...p}><circle cx="12" cy="12" r="3.5" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /></Svg>
export const IconUndo = (p) => <Svg {...p}><path d="M9 7L4 12l5 5M4 12h10a6 6 0 0 1 6 6" /></Svg>
export const IconBan = (p) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M5.7 5.7l12.6 12.6" /></Svg>
export const IconDevice = (p) => <Svg {...p}><rect x="7" y="3" width="10" height="18" rx="2" /><path d="M11 18h2" /></Svg>
