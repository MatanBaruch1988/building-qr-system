import { APP_BUILD } from './build.js'

/**
 * The quiet line that tells which build of the app is running, for example "Version abc1234". `label` is the word for
 * "Version" in the language of the screen (the provider app passes its translation, the Hebrew committee app its own).
 * The id is Latin letters and digits: it is its own left-to-right run (<bdi dir="ltr">), so in Hebrew and Arabic it neither
 * reorders nor takes the surrounding direction.
 */
export default function BuildLabel({ label, className = '' }) {
  return (
    <p className={`w-build${className ? ` ${className}` : ''}`}>
      {label} <bdi dir="ltr">{APP_BUILD}</bdi>
    </p>
  )
}
