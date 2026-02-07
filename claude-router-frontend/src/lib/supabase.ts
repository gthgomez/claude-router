// src/lib/supabase.ts
import { createClient } from '@supabase/supabase-js';
import { CONFIG } from '../config';

/**
 * Singleton Supabase Client
 * 
 * CRITICAL: Only ONE instance should exist in the app.
 * Multiple instances cause:
 * - Auth state conflicts
 * - Session storage issues
 * - Undefined behavior with concurrent requests
 * 
 * L3 ENFORCEMENT: Import this client everywhere, never create new ones.
 */
export const supabase = createClient(
  CONFIG.SUPABASE_URL, 
  CONFIG.SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  }
);
