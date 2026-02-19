// src/hooks/useAuth.ts
// Authentication state management hook with L3 Safety Gates

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import type { Session, User } from '@supabase/supabase-js';

interface AuthState {
  session: Session | null;
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
}

interface UseAuthReturn extends AuthState {
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signUp: (email: string, password: string) => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
  signInWithProvider: (provider: 'google' | 'github') => Promise<{ error: Error | null }>;
}

export const useAuth = (): UseAuthReturn => {
  const [authState, setAuthState] = useState<AuthState>({
    session: null,
    user: null,
    isLoading: true,
    isAuthenticated: false,
  });

  // Initialize auth state on mount
  useEffect(() => {
    // L3 Gate: Get initial session
    const initAuth = async () => {
      try {
        const { data: { session }, error } = await supabase.auth.getSession();
        
        if (error) {
          const lowered = String(error.message || '').toLowerCase();
          if (lowered.includes('invalid refresh token') || lowered.includes('refresh token not found')) {
            console.warn('[useAuth] Clearing stale local auth session');
            await supabase.auth.signOut({ scope: 'local' });
          } else {
            console.error('[useAuth] Session fetch error:', error);
          }
          setAuthState({
            session: null,
            user: null,
            isLoading: false,
            isAuthenticated: false,
          });
          return;
        }

        setAuthState({
          session,
          user: session?.user ?? null,
          isLoading: false,
          isAuthenticated: !!session,
        });
      } catch (err) {
        console.error('[useAuth] Unexpected error:', err);
        setAuthState(prev => ({ ...prev, isLoading: false }));
      }
    };

    initAuth();

    // L3 Gate: Subscribe to auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        console.log('[useAuth] Auth event:', event);
        
        setAuthState({
          session,
          user: session?.user ?? null,
          isLoading: false,
          isAuthenticated: !!session,
        });
      }
    );

    // Cleanup subscription
    return () => {
      subscription.unsubscribe();
    };
  }, []);

  // Sign in with email/password
  const signIn = useCallback(async (email: string, password: string) => {
    // L3 Gate: Validate inputs
    if (!email?.trim() || !password) {
      return { error: new Error('Email and password are required') };
    }

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (error) {
        console.error('[useAuth] Sign in error:', error);
        return { error };
      }

      return { error: null };
    } catch (err) {
      console.error('[useAuth] Unexpected sign in error:', err);
      return { error: err instanceof Error ? err : new Error('Sign in failed') };
    }
  }, []);

  // Sign up with email/password
  const signUp = useCallback(async (email: string, password: string) => {
    // L3 Gate: Validate inputs
    if (!email?.trim() || !password) {
      return { error: new Error('Email and password are required') };
    }

    if (password.length < 6) {
      return { error: new Error('Password must be at least 6 characters') };
    }

    try {
      const { error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
      });

      if (error) {
        console.error('[useAuth] Sign up error:', error);
        return { error };
      }

      return { error: null };
    } catch (err) {
      console.error('[useAuth] Unexpected sign up error:', err);
      return { error: err instanceof Error ? err : new Error('Sign up failed') };
    }
  }, []);

  // Sign out
  const signOut = useCallback(async () => {
    try {
      await supabase.auth.signOut();
    } catch (err) {
      console.error('[useAuth] Sign out error:', err);
    }
  }, []);

  // Sign in with OAuth provider
  const signInWithProvider = useCallback(async (provider: 'google' | 'github') => {
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: window.location.origin,
        },
      });

      if (error) {
        console.error('[useAuth] OAuth error:', error);
        return { error };
      }

      return { error: null };
    } catch (err) {
      console.error('[useAuth] Unexpected OAuth error:', err);
      return { error: err instanceof Error ? err : new Error('OAuth sign in failed') };
    }
  }, []);

  return {
    ...authState,
    signIn,
    signUp,
    signOut,
    signInWithProvider,
  };
};
