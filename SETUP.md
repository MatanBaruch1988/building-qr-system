# הוראות הקמה - מערכת אימות נוכחות QR

## דרישות מקדימות
- Node.js 18 ומעלה
- חשבון Google
- Firebase CLI

## שלב 1: התקנת Firebase CLI

```bash
npm install -g firebase-tools
firebase login
```

## שלב 2: יצירת פרויקט Firebase

1. היכנס ל-[Firebase Console](https://console.firebase.google.com)
2. לחץ "Add project" וצור פרויקט חדש
3. תן לו שם (למשל: "building-qr-system")
4. המתן ליצירת הפרויקט

## שלב 3: הפעלת שירותים ב-Firebase

### Firestore Database:
1. בתפריט הצד לחץ "Firestore Database"
2. לחץ "Create database"
3. בחר "Start in test mode"
4. בחר region (מומלץ: europe-west1)

### Authentication (אופציונלי):
1. בתפריט הצד לחץ "Authentication"
2. לחץ "Get started"
3. הפעל "Anonymous" sign-in

### Hosting:
1. בתפריט הצד לחץ "Hosting"
2. לחץ "Get started"

## שלב 4: הגדרת האפליקציה

1. ב-Firebase Console, לחץ על גלגל השיניים ליד "Project Overview"
2. לחץ "Project settings"
3. גלול למטה ולחץ "Add app" → Web (אייקון `</>`)
4. תן שם לאפליקציה (למשל: "Building QR Web")
5. העתק את הקונפיגורציה

### עדכון קובץ Firebase:
ערוך את הקובץ `src/services/firebase.js` והחלף את הערכים:

```javascript
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
}
```

## שלב 5: הגדרת Google Calendar API

### יצירת Service Account:
1. היכנס ל-[Google Cloud Console](https://console.cloud.google.com)
2. בחר את הפרויקט שנוצר עם Firebase
3. לך ל-APIs & Services → Library
4. חפש "Google Calendar API" והפעל אותו
5. לך ל-APIs & Services → Credentials
6. לחץ "Create Credentials" → "Service Account"
7. תן שם ל-Service Account
8. אחרי היצירה, לחץ על ה-Service Account
9. לך ל-Tab של "Keys"
10. לחץ "Add Key" → "Create new key" → JSON
11. שמור את קובץ ה-JSON

### שיתוף היומן עם Service Account:
1. פתח את Google Calendar ב-ahavatadam86ky@gmail.com
2. לחץ על גלגל השיניים ליד היומן → "Settings and sharing"
3. גלול ל-"Share with specific people"
4. הוסף את כתובת ה-Service Account (נראה כמו: xxxx@project.iam.gserviceaccount.com)
5. תן הרשאת "Make changes to events"

### הגדרת Cloud Functions:
```bash
cd functions
npm install

# הגדר את פרטי ה-Service Account
firebase functions:config:set google.service_account_email="your-sa@project.iam.gserviceaccount.com"
firebase functions:config:set google.private_key="$(cat path/to/service-account.json | jq -r '.private_key')"
firebase functions:config:set calendar.id="ahavatadam86ky@gmail.com"
```

## שלב 6: התקנה והרצה מקומית

```bash
# בתיקייה הראשית
npm install

# הרצה מקומית
npm run dev
```

האפליקציה תהיה זמינה ב: http://localhost:3000

## שלב 7: פריסה לייצור

```bash
# בנה את האפליקציה
npm run build

# חבר לפרויקט Firebase
firebase use --add
# בחר את הפרויקט שלך

# פרוס
firebase deploy
```

## שימוש במערכת

### ניהול (Admin):
1. עבור ללשונית "ניהול"
2. הוסף עובדים עם שם וקוד כניסה
3. הוסף נקודות QR:
   - בחר מיקום על המפה
   - תן שם לנקודה
   - הגדר רדיוס אימות (10 מטר ברירת מחדל)
4. הדפס/הורד את קודי ה-QR והצמד אותם במקום

### סריקה (Worker):
1. עבור ללשונית "סריקת QR"
2. בחר עובד והזן קוד
3. לחץ "התחל סריקה"
4. כוון את המצלמה לקוד ה-QR
5. המערכת תבדוק מיקום אוטומטית

### היסטוריה:
- עבור ללשונית "היסטוריה" לצפייה בכל הסריקות

## פתרון בעיות

### הסריקה לא עובדת:
- ודא שהדפדפן מקבל הרשאת מצלמה
- ודא שאתה משתמש ב-HTTPS (או localhost)

### מיקום לא מדויק:
- GPS בתוך מבנים עלול להיות פחות מדויק
- נסה להגדיל את רדיוס האימות

### אירועים לא נוצרים ביומן:
- בדוק שה-Service Account משותף עם היומן
- בדוק את הלוגים: `firebase functions:log`

## מבנה הקבצים

```
building-qr-system/
├── src/
│   ├── components/
│   │   ├── AdminPanel.jsx    # ממשק ניהול
│   │   ├── QRScanner.jsx     # סורק QR
│   │   ├── WorkerLogin.jsx   # כניסת עובד
│   │   ├── ScanResult.jsx    # תוצאת סריקה
│   │   ├── ScansHistory.jsx  # היסטוריה
│   │   └── LocationMap.jsx   # מפה
│   ├── services/
│   │   ├── firebase.js       # Firebase config
│   │   └── geolocation.js    # GPS
│   ├── utils/
│   │   ├── distance.js       # חישוב מרחק
│   │   └── qrGenerator.js    # יצירת QR
│   ├── App.jsx
│   ├── main.jsx
│   └── index.css
├── functions/
│   ├── index.js              # Cloud Functions
│   └── package.json
├── firebase.json
├── firestore.rules
└── package.json
```
