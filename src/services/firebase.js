import { initializeApp } from 'firebase/app'
import { getFirestore } from 'firebase/firestore'
import { getFunctions } from 'firebase/functions'
import { getAuth, GoogleAuthProvider } from 'firebase/auth'

// Firebase configuration
// IMPORTANT: Replace these values with your Firebase project config
// You can find these in Firebase Console > Project Settings > General > Your apps
const firebaseConfig = {
  apiKey: "AIzaSyD82TrtIVb9rsZOBhAvKFqJut5qOe32Ezs",
  authDomain: "building-qr-system.firebaseapp.com",
  projectId: "building-qr-system",
  storageBucket: "building-qr-system.firebasestorage.app",
  messagingSenderId: "788817425038",
  appId: "1:788817425038:web:30aa2565a7a766ca12cfdf",
  measurementId: "G-0M2TGLYT3F"
}

// Initialize Firebase
const app = initializeApp(firebaseConfig)

// Initialize services
export const db = getFirestore(app)
export const functions = getFunctions(app)
export const auth = getAuth(app)
export const googleProvider = new GoogleAuthProvider()

export default app
