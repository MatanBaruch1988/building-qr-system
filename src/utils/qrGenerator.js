import QRCode from 'qrcode'

function escapeHtml(str) {
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

// כתובת האפליקציה
const APP_URL = 'https://building-qr-system.web.app'

/**
 * Generate a unique QR code URL for a location
 * @param {string} locationId - The location ID
 * @returns {string} Full URL with QR code parameter
 */
export function generateQRCodeString(locationId) {
  const timestamp = Date.now()
  const random = Math.random().toString(36).substring(2, 8)
  const code = `BQR-${locationId}-${timestamp}-${random}`
  // מחזיר URL מלא כדי שסריקה עם כל אפליקציה תפתח את האתר
  return `${APP_URL}/scan?code=${code}`
}

/**
 * Generate QR code as data URL (for displaying in <img>)
 * @param {string} data - The data to encode
 * @param {Object} options - QR code options
 * @returns {Promise<string>} Data URL of the QR code
 */
export async function generateQRCodeDataURL(data, options = {}) {
  const defaultOptions = {
    width: 256,
    margin: 2,
    color: {
      dark: '#000000',
      light: '#FFFFFF'
    },
    errorCorrectionLevel: 'H' // High error correction for better scanning
  }

  return QRCode.toDataURL(data, { ...defaultOptions, ...options })
}

/**
 * Generate QR code and draw to canvas element
 * @param {HTMLCanvasElement} canvas - Canvas element
 * @param {string} data - The data to encode
 * @param {Object} options - QR code options
 */
export async function generateQRCodeToCanvas(canvas, data, options = {}) {
  const defaultOptions = {
    width: 256,
    margin: 2,
    color: {
      dark: '#000000',
      light: '#FFFFFF'
    },
    errorCorrectionLevel: 'H'
  }

  return QRCode.toCanvas(canvas, data, { ...defaultOptions, ...options })
}

/**
 * Parse QR code data to extract location ID
 * Supports both new URL format and legacy format
 * @param {string} qrData - The scanned QR code data
 * @returns {{isValid: boolean, locationId?: string, fullCode?: string, error?: string}}
 */
export function parseQRCodeData(qrData) {
  if (!qrData || typeof qrData !== 'string') {
    return { isValid: false, error: 'קוד QR לא תקין' }
  }

  // תמיכה בפורמט URL חדש
  if (qrData.includes('/scan?code=')) {
    try {
      const url = new URL(qrData)
      const code = url.searchParams.get('code')
      if (code && code.startsWith('BQR-')) {
        const parts = code.split('-')
        if (parts.length >= 4) {
          return { isValid: true, locationId: parts[1], fullCode: code }
        }
      }
    } catch (e) {
      // URL parsing failed, continue to legacy check
    }
  }

  // תמיכה בפורמט ישן: BQR-{locationId}-{timestamp}-{random}
  if (qrData.startsWith('BQR-')) {
    const parts = qrData.split('-')
    if (parts.length >= 4) {
      const locationId = parts[1]
      return { isValid: true, locationId, fullCode: qrData }
    }
    return { isValid: false, error: 'פורמט קוד QR לא תקין' }
  }

  return { isValid: false, error: 'קוד QR לא שייך למערכת זו' }
}

/**
 * Extract just the code from QR data (handles both URL and raw formats)
 * @param {string} qrData - The scanned QR code data
 * @returns {string|null} The extracted code or null
 */
export function extractCodeFromQRData(qrData) {
  if (!qrData) return null

  // אם זה URL, חלץ את הקוד
  if (qrData.includes('/scan?code=')) {
    try {
      const url = new URL(qrData)
      return url.searchParams.get('code')
    } catch (e) {
      return null
    }
  }

  // אם זה כבר קוד ישיר
  if (qrData.startsWith('BQR-')) {
    return qrData
  }

  return null
}

/**
 * Download QR code as image file
 * @param {string} dataUrl - The QR code data URL
 * @param {string} filename - The filename for download
 */
export function downloadQRCode(dataUrl, filename = 'qrcode.png') {
  const link = document.createElement('a')
  link.href = dataUrl
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}

/**
 * Print QR code
 * @param {string} dataUrl - The QR code data URL
 * @param {string} title - Title to print above QR code
 */
export function printQRCode(dataUrl, title = '') {
  const printWindow = window.open('', '_blank')

  // Create an image element first to ensure it's loaded
  const img = new Image()
  img.onload = () => {
    printWindow.document.write(`
      <!DOCTYPE html>
      <html dir="rtl">
      <head>
        <title>הדפסת QR - ${escapeHtml(title)}</title>
        <style>
          body {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            font-family: Arial, sans-serif;
            margin: 0;
            padding: 20px;
          }
          h1 {
            font-size: 24px;
            margin-bottom: 20px;
            text-align: center;
          }
          img {
            max-width: 300px;
          }
          .instructions {
            margin-top: 20px;
            font-size: 14px;
            color: #666;
            text-align: center;
          }
          @media print {
            body { padding: 0; }
          }
        </style>
      </head>
      <body>
        <h1>${escapeHtml(title)}</h1>
        <img src="${dataUrl}" alt="QR Code" />
        <p class="instructions">סרוק קוד זה לאימות נוכחות</p>
      </body>
      </html>
    `)
    printWindow.document.close()
    printWindow.focus()

    // Wait for the document to fully render before printing
    setTimeout(() => {
      printWindow.print()
    }, 500)
  }

  // Start loading the image
  img.src = dataUrl
}
