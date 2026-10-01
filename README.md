# נוכחות בבניין עם QR

כלי לוועד הבית מול נותני שירות (חברת ניקיון, גנן):

1. **הוועד** מגדיר נקודות בבניין ומדפיס לכל אחת שלט עם QR.
2. **נותן השירות** סורק את ה-QR עם מצלמת הטלפון. אחרי כניסה חד-פעמית עם סיסמה אישית, כל סריקה היא טאפ אחד.
3. כל סריקה נשמרת כשורה אחת במסד נתונים נקי. **האפליקציה לא מנתחת כלום**: אייג'נט קורא את הנתונים דרך API לקריאה בלבד
   ([docs/agent-api.md](docs/agent-api.md)).

## איך זה בנוי

| חלק | מה |
|---|---|
| אפליקציית נותני השירות | `/` ו-`/scan?code=…`. עברית / אנגלית / רוסית / ערבית, עובדת גם בלי קליטה (תור מקומי שנשלח לבד). קוד ב-`src/worker`, `src/i18n`, `src/pages/WorkerApp.jsx` |
| ממשק הוועד | `/admin`. כניסה **רק עם חשבון Google** מרשימת הוועד. נקודות, נותני שירות, היסטוריה, מפתחות אייג'נט. קוד ב-`src/admin` |
| API | פונקציית Vercel אחת (`api/index.js`, שאליה `vercel.json` מנתב כל `/api/*`) שמריצה את `server/`. Postgres (Neon) דרך `pg` |
| מסד נתונים | `db/migrations/*.sql`. סריקות הן append-only (אין מחיקה, רק ביטול), ספקים ונקודות מושבתים ולא נמחקים |

**מדיניות המיקום ("GPS רך")**: סריקה נדחית רק כשיש מיקום מדויק ורחוק בבירור מהנקודה. בלי קליטה או עם מיקום חלש הנוכחות
נרשמת ומסומנת `location_unverified`. לכל נקודה אפשר להגדיר `required` / `optional` / `none` (למרתפים).

## פיתוח מקומי

```bash
npm install
cp .env.example .env.local        # ולמלא DATABASE_URL (ראו למטה)
npm run db:seed-dev               # סכמת פיתוח נפרדת (dev_ui) עם נתוני דוגמה: לא נוגעת בנתונים האמיתיים
npm run dev:api -- --schema=dev_ui   # שרת ה-API המקומי (פורט 3001) + כניסת אדמין לפיתוח בלי Google
npm run dev                       # הממשק (פורט 3000, מעביר /api ל-3001)
npm run test:unit                 # vitest: לוגיקה, API, רכיבים (יוצרות סכמה זמנית ומוחקות אותה)
npm run test:e2e                  # Playwright: דפדפן אמיתי, פיקסל (Chromium) ואייפון (WebKit)
npm test                          # שתיהן
```

בדיקות הדפדפן דורשות התקנה חד-פעמית של הדפדפנים: `npx playwright install chromium webkit`.
מה אי אפשר לבדוק אוטומטית (התקנה למסך הבית באייפון ועוד) מופיע ב-[docs/manual-ios-checklist.md](docs/manual-ios-checklist.md).

משתמשי הדוגמה מוגדרים ב-`scripts/dev-seed.mjs` (סיסמאות פיתוח בלבד, קיימות רק בסכמת `dev_ui`).

## הגדרת כניסת Google לוועד (פעם אחת)

1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → **Create credentials → OAuth client ID → Web application**.
2. **Authorized JavaScript origins**: הכתובת של האתר (למשל `https://building-qr-system.vercel.app`) ו-`http://localhost:3000` לפיתוח.
3. אם מסך ההסכמה במצב Testing: הוסיפו את כתובות ה-Gmail של הוועד תחת **Test users** (או פרסמו את האפליקציה).
4. העתיקו את ה-Client ID אל `GOOGLE_CLIENT_ID` ב-Vercel (Production) וב-`.env.local`.
5. הוסיפו את חבר הוועד הראשון: `npm run db:create-admin -- you@gmail.com "השם שלכם"`. את האחרים מוסיפים ממסך "ועד".

## המעבר מהמערכת הישנה (Firebase): בוצע

המעבר הושלם ב-1.10.2026. מה נשאר ממנו:

- **הנתונים** יובאו ל-Postgres (`npm run db:import-firestore -- <תיקיית יצוא>`, ניסוי בלי כתיבה ואז עם `--apply`). קודי ה-QR המודפסים נשמרו כפי שהם. **סיסמאות לא עברו** (הישנות היו SHA-256 בלי מלח), ולכן הוגדרו סיסמאות חדשות במסך "נותני שירות".
- **הגיבוי** של Firestore (קבצי JSON) שמור מחוץ ל-git, בתיקייה `../backups/firestore-2026-10-01`. סקריפט היצוא וההתלות שלו הוסרו.
- **ה-QR שכבר מודפסים** מצביעים על `building-qr-system.web.app`. אתר ההפניה הקטן ב-`legacy-redirect/` מעביר אותם לכתובת החדשה (ומנקה את ה-PWA הישנה מהטלפונים). אם הכתובת הציבורית משתנה, עדכנו `NEW_ORIGIN` ב-`legacy-redirect/public/index.html` ופרסו מחדש: `cd legacy-redirect && firebase deploy --only hosting`.
- **Firestore נעול** (`legacy-redirect/firestore.rules`: אסור הכול) והנתונים הישנים נשארים בו כגיבוי. כשמחליטים שהגיבוי מיותר אפשר למחוק את הפרויקט ב-Firebase, אחרי שה-QR המודפסים הוחלפו או שאתר ההפניה כבר לא נחוץ.
- **משתני Vercel** של Firebase נמחקו.

## מבנה

```
api/index.js           נקודת הכניסה של Vercel (כל /api/* מנותב אליה ב-vercel.json)
server/                ה-API: routes/, auth, scans (הכללים), google (אימות), db, migrate
db/migrations/         סכמת ה-DB
scripts/               מיגרציה, יצירת אדמין, זריעת פיתוח, ייצוא/ייבוא מ-Firestore
src/worker, src/i18n   אפליקציית נותני השירות
src/admin              ממשק הוועד
tests/                 vitest (לוגיקה, API מול Postgres אמיתי בסכמה זמנית, i18n, ייבוא, tests/components לרכיבים)
e2e/                   Playwright (PWA, אפליקציית נותני השירות, ממשק הוועד) על פיקסל ואייפון
legacy-redirect/       אתר הפניה ל-QR המודפסים הישנים
```
