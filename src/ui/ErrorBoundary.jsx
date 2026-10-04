import { Component, useEffect, useRef } from 'react'
import { IconAlert } from '../worker/icons.jsx'
import { currentApp } from '../appKind.js'
import { crashText, reloadApp } from './crash.js'
import './ui.css' // the tokens and classes of the fallback: it must not depend on a screen that may not have loaded

/**
 * The screen that takes the place of one that broke while rendering. Without it React unmounts everything and the person
 * is left with a blank page and no way back, on a phone that may keep this build for weeks.
 *
 * It stands on its own: its own root with the colour tokens (they follow the theme that <html data-theme> holds, which is
 * set outside React), its own language and direction (read by crashText in crash.js), no provider and no data.
 */
export function CrashScreen({ app, onRetry }) {
  const { lang, dir, title, retry, reload } = crashText(app)
  const headingRef = useRef(null)
  useEffect(() => {
    headingRef.current?.focus() // a screen reader reads the message; the buttons are the next stops
  }, [])
  return (
    <div className="w-app" lang={lang} dir={dir}>
      <div className="w-shell">
        <main className="w-result w-result--danger w-crash">
          <div className="w-ring"><IconAlert /></div>
          <div role="alert">
            <h1 tabIndex={-1} ref={headingRef}>{title}</h1>
          </div>
          <div className="w-actions">
            <button className="w-btn" onClick={onRetry}>{retry}</button>
            <button className="w-btn w-btn--quiet" onClick={() => reloadApp()}>{reload}</button>
          </div>
        </main>
      </div>
    </div>
  )
}

/**
 * Sits above the whole app (main.jsx), so it catches a crash in either app and in the language provider itself. React
 * still needs a class for this. It does not log: createRoot's onCaughtError does (crashRootOptions in crash.js), because
 * React's own handler would otherwise print the message and the component stack.
 *
 * "Try again" renders the children afresh. A screen that fails for the same reason fails again, and so does one whose
 * download failed (React keeps the failure of a lazy import, here the committee app's); "Reload the app" is the way out
 * of those, and it applies a waiting update.
 */
export default class ErrorBoundary extends Component {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true } // the error itself is not kept: nothing here needs it
  }

  retry = () => this.setState({ failed: false })

  render() {
    if (!this.state.failed) return this.props.children
    return <CrashScreen app={this.props.app ?? currentApp()} onRetry={this.retry} />
  }
}
