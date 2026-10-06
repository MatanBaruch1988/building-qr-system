# Manual check on a real iPhone, before a release

Playwright's WebKit is the Safari engine on a computer. It is not an iPhone: it cannot install to the Home Screen,
run standalone, show the status bar, or go offline with a service worker. These are the things the automatic tests
cannot see. Use a real iPhone with Safari, on the deployed address (`https://<your-domain>`; the first installation's is
`https://building-qr-system.vercel.app`).

Do this when a release touches the manifest, the service worker, the icons, the layout, the top bar, the date
fields, or the location flow. Otherwise a quick pass over items 1, 4 and 8 is enough.

Mark each item OK or write what you saw. Take a screenshot of anything that looks wrong.

## Install and standalone

1. [ ] Open the address in Safari, then Share, then **Add to Home Screen**. The name shown is the app's short
   name in Hebrew (the word for "attendance") and the icon is the app's icon (a blue square with a white QR mark,
   with no black corners), not a screenshot of the page. The icon is `public/apple-touch-icon.png`. If you added the
   app before this icon existed, remove it and add it again: iOS keeps the icon it saw the first time.
2. [ ] Open it from the Home Screen: no Safari bar, the app fills the screen, and the first thing visible is the
   building name (when the committee set one) and address in the top bar.
3. [ ] The status bar (time, battery) is readable against the app in both light and dark mode, and nothing is hidden
   behind the notch or the Dynamic Island. Content starts below it.
4. [ ] The bottom edge: nothing is cut off by the home indicator (the last button is fully visible and tappable).

## Offline

5. [ ] Open the app once with a network, then close it fully (swipe it away). Turn on Airplane mode and open it from
   the Home Screen: it opens and shows the sign-in list.
6. [ ] While in Airplane mode, scan a printed QR with the camera (or open a `/scan?code=` link from Notes): the app
   opens and says the visit is saved on the phone. Turn Airplane mode off: within about half a minute the visit is
   sent and the home screen says so. In the committee's list of that provider's phones
   (`GET /api/admin/providers/<id>/devices`, signed in as the committee) the phone shows the visit waiting for as long
   as it is not sent (`waiting_count` 1 and the time it was saved), then nothing waiting and the time of the upload.

## Location

7. [ ] At a point whose GPS mode is `required`, the first scan asks for location permission, in the person's language.
   Allow it: the visit is recorded. Then Settings, Safari (or the app), Location: set it to Never, scan again: the
   app says location is needed and explains where to switch it on.
8. [ ] Standing at the real point: a check-in succeeds. (If it fails indoors, note whether the message is clear.)

## Look and feel on the phone

9. [ ] Light and dark: the picker in the top bar switches the app, and "follow the device" follows the iPhone's
   appearance setting, including when it changes while the app is open.
10. [ ] Language: Hebrew, English, Russian, Arabic. Right-to-left screens (Hebrew, Arabic) are mirrored, the
    arrows point the right way, and no text is cut off.
11. [ ] Typing a password: the keyboard does not zoom the page, the password manager offers the saved login, and the
    show/hide eye works.
12. [ ] Committee app (`/admin`) on the phone: the History tab's two date fields sit side by side without overlapping,
    the point tiles show four icons (QR, edit, switch off, delete), and nothing scrolls sideways.

## Updates

13. [ ] After a new version is deployed, open the installed app: the "update available" banner appears, and tapping it
    loads the new version (the committee and provider screens still work). The "Version" line at the foot of the home
    screen (and of the Committee tab in the committee app) shows the id of the new commit: the first 7 characters of it,
    the same as the `commit` of `GET /api/health`.

## Printed QR

14. [ ] The first installation only: a copy that never printed codes for the old app skips this item. Scan a printed QR
    from before the move (`building-qr-system.web.app`, the old Firebase address that `legacy-redirect/` forwards): it
    lands on the new address with the right point, and signing in and checking in works.

## Crashes

15. [ ] If the crash screen ("Something went wrong on this screen") showed up during this pass, tap "Reload the app"
    and sign in: the phone sends the report of that crash by itself (a crash before sign-in waits on the phone until
    the next sign-in), and nothing about it is shown to the person.
