// Which of the two apps this page is. There is no router: /admin is the committee app, every other path (/, /scan?code=...)
// is the service-provider app, and a link from one to the other is an ordinary page load, so the answer never changes
// while a page is open. App.jsx picks the app to render by it, and the crash screen (src/ui/ErrorBoundary.jsx) picks the
// language and the wording by it.

export const APP_PROVIDER = 'provider'
export const APP_COMMITTEE = 'committee'

export const isAdminPath = () => /^\/admin(\/|$)/.test(window.location.pathname)

export const currentApp = () => (isAdminPath() ? APP_COMMITTEE : APP_PROVIDER)
