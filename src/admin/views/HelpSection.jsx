import { useId, useState } from 'react'
import { IconInfo, IconChevron } from '../icons.jsx'
import { HELP_TOPICS } from '../help.js'

/**
 * A short guide to working with the system, in the Committee tab: a section that a button opens, built like the audit log's
 * (a disclosure whose button is the heading of the section, closed at first, and its content drawn only when it is open).
 * Plain text, with no actions in it, so there is nothing to put in the order of a tile's actions. The text is in help.js.
 * The topics are <h3>, under the <h2> that holds the button, and are flat: no topic has a heading of its own below it.
 */
export default function HelpSection() {
  const id = useId()
  const [open, setOpen] = useState(false)
  return (
    <section className="a-help-section" aria-labelledby={`${id}-title`}>
      <h2 className="a-disclosure" id={`${id}-title`}>
        <button type="button" className="a-disclosure__btn" aria-expanded={open} aria-controls={`${id}-panel`} onClick={() => setOpen((o) => !o)}>
          <IconInfo size={24} />
          <span className="a-disclosure__text">איך עובדים עם המערכת</span>
          <IconChevron size={22} className="a-disclosure__chevron" />
        </button>
      </h2>
      <div id={`${id}-panel`} hidden={!open}>
        {open && (
          <div className="a-card a-help">
            {HELP_TOPICS.map((topic) => (
              <div key={topic.title} className="a-help__topic">
                <h3 className="a-card__title">{topic.title}</h3>
                <p>{topic.text}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
