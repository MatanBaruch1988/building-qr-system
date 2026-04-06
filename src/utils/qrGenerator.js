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
 * Print all QR codes in a 3x3 grid (A4 pages)
 * @param {Array} locations - Array of location objects with qrCode and name fields
 */
export async function printAllQRCodes(locations) {
  const active = locations.filter(loc => loc.qrCode)
  if (active.length === 0) return

  // Generate all data URLs in parallel
  const items = await Promise.all(
    active.map(async (loc) => ({
      name: loc.name || '',
      description: loc.description || '',
      latitude: loc.latitude,
      longitude: loc.longitude,
      dataUrl: await generateQRCodeDataURL(loc.qrCode, { width: 300 })
    }))
  )

  // Pad to fill complete pages (multiples of 6)
  while (items.length % 6 !== 0) {
    items.push({ name: '', dataUrl: null })
  }

  const printWindow = window.open('', '_blank')

  // Split into pages of 6
  const pages = []
  for (let i = 0; i < items.length; i += 6) {
    pages.push(items.slice(i, i + 6))
  }

  const formatCoords = (lat, lng) => {
    if (lat == null || lng == null) return ''
    return `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`
  }

  const pagesHtml = pages.map((page, pi) => `
    <div class="page">
      ${page.map(item => item.dataUrl ? `
        <div class="cell">
          <div class="cell-header">
            <p class="cell-name">${escapeHtml(item.name)}</p>
            ${item.description ? `<p class="cell-desc">${escapeHtml(item.description)}</p>` : ''}
          </div>
          <img src="${item.dataUrl}" alt="QR Code" />
          ${formatCoords(item.latitude, item.longitude) ? `<p class="cell-coords">${formatCoords(item.latitude, item.longitude)}</p>` : ''}
        </div>
      ` : '<div class="cell empty"></div>').join('')}
    </div>
  `).join('')

  printWindow.document.write(`
    <!DOCTYPE html>
    <html dir="rtl">
    <head>
      <meta charset="utf-8" />
      <title>כל קודי QR</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: Arial, Helvetica, sans-serif; background: #fff; }
        .page {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          grid-template-rows: repeat(2, 1fr);
          width: 297mm;
          height: 210mm;
          page-break-after: always;
          break-after: page;
        }
        .page:last-child {
          page-break-after: avoid;
          break-after: avoid;
        }
        .cell {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: space-between;
          padding: 5mm 6mm;
          border: 0.3mm solid #ccc;
          overflow: hidden;
        }
        .cell.empty { border-color: #eee; }
        .cell-header {
          text-align: center;
          width: 100%;
        }
        .cell-name {
          font-size: 12pt;
          font-weight: bold;
          color: #000;
          line-height: 1.2;
          word-break: break-word;
        }
        .cell-desc {
          font-size: 9pt;
          color: #444;
          margin-top: 1mm;
          line-height: 1.2;
          word-break: break-word;
        }
        .cell img {
          width: 60mm;
          height: 60mm;
          flex-shrink: 0;
        }
        .cell-coords {
          font-size: 8pt;
          color: #666;
          font-family: 'Courier New', monospace;
          text-align: center;
          direction: ltr;
        }
        @media print {
          @page { size: A4 landscape; margin: 0; }
          body { width: 297mm; }
        }
      </style>
    </head>
    <body>
      ${pagesHtml}
      <script>
        window.onload = function() {
          setTimeout(function() { window.print(); }, 400);
        };
      </script>
    </body>
    </html>
  `)
  printWindow.document.close()
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
