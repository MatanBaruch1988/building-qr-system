import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

/** A crisp, scannable QR as a PNG data URL. Level M leaves room to survive a scuffed print. */
export const qrDataUrl = (text, width = 720) =>
  QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 2, width, color: { dark: '#000000', light: '#ffffff' } })

export function useQrImage(text) {
  const [src, setSrc] = useState(null)
  useEffect(() => {
    let cancelled = false
    setSrc(null)
    if (text) qrDataUrl(text).then((url) => !cancelled && setSrc(url))
    return () => {
      cancelled = true
    }
  }, [text])
  return src
}

export function downloadDataUrl(dataUrl, filename) {
  const a = document.createElement('a')
  a.href = dataUrl
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/** File-name-safe version of a point name (Hebrew stays readable). */
export const safeFileName = (name) => name.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '') || 'qr'
