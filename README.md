# נוכחות בבניין — QR

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
npm test                          # כל הבדיקות (הבדיקות יוצרות סכמה זמנית ומוחקות אותה)
```

משתמשי הדוגמה מוגדרים ב-`scripts/dev-seed.mjs` (סיסמאות פיתוח בלבד, קיימות רק בסכמת `dev_ui`).

## הגדרת כניסת Google לוועד (פעם אחת)

1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → **Create credentials → OAuth client ID → Web application**.
2. **Authorized JavaScript origins**: הכתובת של האתר (למשל `https://building-qr-system.vercel.app`) ו-`http://localhost:3000` לפיתוח.
3. אם מסך ההסכמה במצב Testing: הוסיפו את כתובות ה-Gmail של הוועד תחת **Test users** (או פרסמו את האפליקציה).
4. העתיקו את ה-Client ID אל `GOOGLE_CLIENT_ID` ב-Vercel (Production) וב-`.env.local`.
5. הוסיפו את חבר הוועד הראשון: `npm run db:create-admin -- you@gmail.com "השם שלכם"`. את האחרים מוסיפים ממסך "ועד".

## מעבר מהמערכת הישנה (Firebase) — צ'קליסט

1. גיבוי טרי: `npm run db:export-firestore -- ../backups/firestore-<date>`
2. ייבוא, קודם ניסוי בלי כתיבה ואז אמיתי:
   `npm run db:import-firestore -- ../backups/firestore-<date>` ואחר כך עם `--apply`.
   הייבוא שומר את קודי ה-QR המודפסים כפי שהם. **סיסמאות לא עוברות** (הישנות היו SHA-256 בלי מלח): הגדירו סיסמה חדשה לכל ספק במסך "נותני שירות".
3. `npm run db:migrate` מול המסד האמיתי.
4. משתני סביבה ב-Vercel: `DATABASE_URL`, `GOOGLE_CLIENT_ID`, `APP_BASE_URL` (הכתובת הציבורית, בלי `/` בסוף).
5. הפריסה עצמה (`vercel --prod` או Redeploy בדשבורד). אחרי הפריסה מחקו מ-Vercel את `FIREBASE_SERVICE_ACCOUNT_KEY` ואת משתני `VITE_FIREBASE_*`.
6. ה-QR שכבר מודפסים מצביעים על `building-qr-system.web.app`. כדי שימשיכו לעבוד, פרסו את אתר ההפניה הקטן:
   `cd legacy-redirect && firebase deploy --only hosting` (אם יש דומיין אחר, עדכנו `NEW_ORIGIN` ב-`legacy-redirect/public/index.html`).
7. סרקו QR מודפס אחד בטלפון אמיתי וודאו שהוא נפתח ומתעד נוכחות.
8. השאירו את Firestore לקריאה בלבד כגיבוי כ-30 יום, ואז אפשר למחוק את הפרויקט ב-Firebase.

## מבנה

```
api/index.js           נקודת הכניסה של Vercel (כל /api/* מנותב אליה ב-vercel.json)
server/                ה-API: routes/, auth, scans (הכללים), google (אימות), db, migrate
db/migrations/         סכמת ה-DB
scripts/               מיגרציה, יצירת אדמין, זריעת פיתוח, ייצוא/ייבוא מ-Firestore
src/worker, src/i18n   אפליקציית נותני השירות
src/admin              ממשק הוועד
tests/                 vitest (לוגיקה, API מול Postgres אמיתי בסכמה זמנית, i18n, ייבוא)
legacy-redirect/       אתר הפניה ל-QR המודפסים הישנים
```
