'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';
import { auth, googleProvider } from './firebase';
import {
  User,
  onAuthStateChanged,
  signInWithPopup,
  signOut as firebaseSignOut,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
} from 'firebase/auth';

export interface AppUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  getIdToken: () => Promise<string>;
  isDevUser?: boolean;
}

interface AuthContextType {
  user: AppUser | null;
  loading: boolean;
  error: string | null;
  isFirebaseConfigured: boolean;
  signInWithGoogle: () => Promise<void>;
  signInWithEmail: (email: string, pass: string, isSignUp?: boolean) => Promise<void>;
  signInAsDevUser: (name?: string, email?: string) => void;
  signOut: () => Promise<void>;
  clearError: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const DEV_STORAGE_KEY = 'downbeat_dev_user';

/** Fake dev logins (server must also have ALLOW_DEV_TOKENS=true). Off in production builds. */
export const DEV_LOGIN_ENABLED = process.env.NEXT_PUBLIC_ALLOW_DEV_LOGIN === 'true';

const devSlug = (name: string) => name.toLowerCase().split(' ')[0].replace(/[^a-z0-9_-]/g, '') || 'alex';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY || '';
  const isFirebaseConfigured = Boolean(
    apiKey && !apiKey.includes('Dummy') && !apiKey.includes('your-')
  );

  useEffect(() => {
    // Check if there's a dev user stored in localStorage
    if (typeof window !== 'undefined' && DEV_LOGIN_ENABLED) {
      const storedDevUser = localStorage.getItem(DEV_STORAGE_KEY);
      if (storedDevUser) {
        try {
          const parsed = JSON.parse(storedDevUser);
          setUser({
            uid: parsed.uid,
            email: parsed.email,
            displayName: parsed.displayName,
            isDevUser: true,
            getIdToken: async () => `dev-mock-token-${String(parsed.uid).replace(/^dev-user-/, '')}`,
          });
          setLoading(false);
          return;
        } catch (e) {
          localStorage.removeItem(DEV_STORAGE_KEY);
        }
      }
    }

    // Subscribe to Firebase Auth
    const unsubscribe = onAuthStateChanged(
      auth,
      (firebaseUser) => {
        if (firebaseUser) {
          setUser({
            uid: firebaseUser.uid,
            email: firebaseUser.email,
            displayName: firebaseUser.displayName,
            isDevUser: false,
            getIdToken: () => firebaseUser.getIdToken(),
          });
        } else {
          setUser((prev) => (prev?.isDevUser ? prev : null));
        }
        setLoading(false);
      },
      (err) => {
        console.warn('[Auth] Firebase Auth state error:', err.message);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, []);

  const signInWithGoogle = async () => {
    try {
      setError(null);
      setLoading(true);
      await signInWithPopup(auth, googleProvider);
    } catch (err: any) {
      if (err.code === 'auth/api-key-not-valid' || !isFirebaseConfigured) {
        setError(
          'Firebase sign-in is not configured (check NEXT_PUBLIC_FIREBASE_* in web/.env.local).'
        );
      } else {
        setError(err.message || 'Failed to sign in with Google');
      }
      throw err;
    } finally {
      setLoading(false);
    }
  };

  const signInWithEmail = async (email: string, pass: string, isSignUp = false) => {
    try {
      setError(null);
      setLoading(true);
      if (isSignUp) {
        await createUserWithEmailAndPassword(auth, email, pass);
      } else {
        await signInWithEmailAndPassword(auth, email, pass);
      }
    } catch (err: any) {
      if (err.code === 'auth/api-key-not-valid' || !isFirebaseConfigured) {
        setError(
          'Firebase sign-in is not configured (check NEXT_PUBLIC_FIREBASE_* in web/.env.local).'
        );
      } else {
        setError(err.message || 'Failed to authenticate');
      }
      throw err;
    } finally {
      setLoading(false);
    }
  };

  const signInAsDevUser = (name = 'Alex Beatmaker', email = 'alex@downbeat.audio') => {
    if (!DEV_LOGIN_ENABLED) return;
    setError(null);
    const slug = devSlug(name);
    // Must match the server's mapping: "dev-mock-token-<slug>" -> uid "dev-user-<slug>"
    const devUserObj: AppUser = {
      uid: `dev-user-${slug}`,
      email,
      displayName: name,
      isDevUser: true,
      getIdToken: async () => `dev-mock-token-${slug}`,
    };

    if (typeof window !== 'undefined') {
      localStorage.setItem(
        DEV_STORAGE_KEY,
        JSON.stringify({ uid: devUserObj.uid, email, displayName: name })
      );
    }

    setUser(devUserObj);
  };

  const signOut = async () => {
    try {
      if (typeof window !== 'undefined') {
        localStorage.removeItem(DEV_STORAGE_KEY);
      }
      await firebaseSignOut(auth);
    } catch (e) {
      // Ignore
    } finally {
      setUser(null);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        error,
        isFirebaseConfigured,
        signInWithGoogle,
        signInWithEmail,
        signInAsDevUser,
        signOut,
        clearError: () => setError(null),
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
