// The short guide "how to work with the system" that a button at the foot of the Committee tab opens (HelpSection.jsx). It is
// written for the members of the committee, in Hebrew like the rest of the committee app, and it uses the names that the
// screens use (the tabs, the buttons and the fields), so that what it says can be found on the screen. When a screen renames a
// button, rename it here too: tests/components/committee-help.test.jsx keeps the guide short, but it cannot know the names.
//
// One entry per topic, in the order of the screen: a heading and two to four short sentences. Keep the whole guide under
// HELP_MAX_LENGTH characters (the test measures it): a guide that is long is not read.

/** The most characters that the open guide may hold, in all of its headings and sentences. */
export const HELP_MAX_LENGTH = 3000

/** @type {ReadonlyArray<{ title: string, text: string }>} */
export const HELP_TOPICS = [
  {
    title: 'נקודות ושלטי QR',
    text: 'בלשונית "נקודות" לוחצים על "נקודה חדשה", נותנים לה שם (למשל לובי) ושומרים. אחר כך נפתח חלון עם ה-QR של הנקודה (אפשר לפתוח אותו שוב עם "QR והדפסה"). לוחצים על "הדפסת שלט" ותולים אותו במקום שבו נותן השירות עובד. בשדה "בדיקת מיקום" אפשר לבחור "מיקום חובה", ואז גם ביקור בלי מיקום תקין לא ייקלט (ביקור מרחוק לא נקלט בשום מקרה).',
  },
  {
    title: 'נותני שירות והטלפונים שלהם',
    text: 'בלשונית "ספקים" לוחצים על "נותן שירות חדש", ממלאים שם ומוסרים לו את הסיסמה. היא מוצגת פעם אחת, ואם נשכחה מגדירים חדשה ב"סיסמה חדשה". בכרטיס של מי שנכנס בטלפון יש כפתור "מכשירים". הוא מראה לכל טלפון כמה ביקורים ממתינים בו ומאז מתי, ואת גרסת האפליקציה.',
  },
  {
    title: "היסטוריה ו'לא נקלטו'",
    text: 'בלשונית "היסטוריה" רואים את כל הנוכחויות שנרשמו, ואפשר לסנן אותן ולייצא ל-Excel. בשדה "סוג" אפשר לבחור "לא נקלטו": ביקורים שהשרת לא קלט, למשל כי הנקודה כבויה או שנותן השירות לא משויך אליה. הם לא נספרים כנוכחות, והרשימה הזו לקריאה בלבד.',
  },
  {
    title: "האייג'נט",
    text: `בלשונית "אייג׳נט" לוחצים על "מפתח חדש" ומוסרים את המפתח לאייג'נט ה-AI של הוועד. המפתח מאפשר קריאה בלבד: אי אפשר לשנות דרכו שום דבר. הוא מוצג פעם אחת, ואם נחשף מבטלים אותו ב"ביטול המפתח" ויוצרים חדש.`,
  },
  {
    title: 'יומן הפעולות',
    text: 'בתחתית הלשונית "ועד" יש את "יומן פעולות". הוא מראה מי עשה מה ומתי, למשל מי השבית נקודה או הסיר גישה של חבר ועד. אפשר לסנן אותו, אבל הוא לקריאה בלבד.',
  },
  {
    title: 'כשמגיעה התראה',
    text: 'כשיש תקלה במערכת, התראה נשלחת במייל למי שמתחזק אותה. היא לא מגיעה לוועד, והוועד לא צריך לעשות כלום ולא צריך לענות.',
  },
  {
    title: 'כשטלפון תקוע',
    text: 'אם נותן שירות אומר שביקור שלו לא נרשם, ב"מכשירים" בכרטיס שלו רואים כמה ביקורים ממתינים בטלפון. מבקשים ממנו לפתוח את האפליקציה במקום שיש בו קליטה, והביקורים יעלו לבד. לא מנקים את נתוני האפליקציה בטלפון לפני שהביקורים הממתינים עלו, כי הם נמחקים יחד איתם.',
  },
]
