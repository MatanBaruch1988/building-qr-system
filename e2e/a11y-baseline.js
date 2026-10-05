// Accessibility problems that are known and not fixed yet, found by the axe scan of e2e/a11y.spec.js. Each entry is one
// rule on one element of one screen, matched exactly, and an entry whose problem no longer occurs fails the test, so
// this list can only shrink. An entry is for a problem whose fix is a design decision of the committee; anything that
// can be fixed in the code is fixed there instead.
//
//   screen: the `context` that the spec gives the scan, with its theme: "provider he: sign-in list [dark]" (it is in the
//           report of the failing test; the same problem in both themes is two entries). It must be a screen that the spec
//           scans: tests/a11y-report.test.js reads the names from e2e/a11y.spec.js and fails for an entry of a screen that was
//           renamed or removed, which the scan itself could not notice
//   rule:   the axe rule id
//   target: the CSS target that axe reports for the element
//   reason: why it is not fixed
//
// Empty today: the first scan found nothing that WCAG 2.1 A and AA, as axe checks them, calls a problem.
export const A11Y_BASELINE = []
