// config.ts - Configuration and environment variables
import { MODEL_CATALOG } from './modelCatalog';

const ENV_SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const ENV_ROUTER_ENDPOINT = import.meta.env.VITE_ROUTER_ENDPOINT || '';
const DERIVED_SUPABASE_URL = ENV_ROUTER_ENDPOINT
  ? String(ENV_ROUTER_ENDPOINT).replace(/\/functions\/v1\/router$/, '')
  : '';

function hostOf(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return '';
  }
}

const SUPABASE_URL = ENV_SUPABASE_URL || DERIVED_SUPABASE_URL;
const ENABLE_VIDEO_PIPELINE = (() => {
  const raw = String(import.meta.env.VITE_ENABLE_VIDEO_PIPELINE || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
})();

function functionEndpoint(name: string): string {
  if (!SUPABASE_URL) return '';
  return `${String(SUPABASE_URL).replace(/\/$/, '')}/functions/v1/${name}`;
}

const ROUTER_ENDPOINT = (() => {
  if (ENV_ROUTER_ENDPOINT && hostOf(ENV_ROUTER_ENDPOINT) === hostOf(SUPABASE_URL)) {
    return ENV_ROUTER_ENDPOINT;
  }
  if (SUPABASE_URL) {
    return `${String(SUPABASE_URL).replace(/\/$/, '')}/functions/v1/router`;
  }
  return '';
})();

export const CONFIG = {
  // Supabase Configuration
  SUPABASE_URL,
  SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY || '',
  
  // Router Endpoint (modern format: https://[PROJECT_ID].supabase.co/functions/v1/[function-name])
  ROUTER_ENDPOINT,
  VIDEO_INTAKE_ENDPOINT: functionEndpoint('video-intake'),
  VIDEO_STATUS_ENDPOINT: functionEndpoint('video-status'),
  
  // Platform Detection
  PLATFORM: (() => {
    const ua = navigator.userAgent;
    if (/Android|iPhone|iPad|iPod/i.test(ua)) return 'mobile';
    if (/Electron/i.test(ua)) return 'desktop';
    return 'web';
  })() as 'web' | 'mobile' | 'desktop',
  
  // Model Configuration
  MODELS: MODEL_CATALOG,
  ENABLE_VIDEO_PIPELINE,
} as const;

// Validate required config
if (!CONFIG.SUPABASE_URL) {
  console.warn('⚠️ VITE_SUPABASE_URL not set. Supabase client initialization will fail.');
}
if (!CONFIG.SUPABASE_ANON_KEY) {
  console.warn('⚠️ VITE_SUPABASE_ANON_KEY not set. Router requests will fail.');
}
if (!CONFIG.ROUTER_ENDPOINT) {
  console.warn('⚠️ VITE_ROUTER_ENDPOINT not set. Router requests will fail.');
}
if (ENV_ROUTER_ENDPOINT && hostOf(ENV_ROUTER_ENDPOINT) !== hostOf(CONFIG.SUPABASE_URL)) {
  console.warn('⚠️ VITE_ROUTER_ENDPOINT host does not match VITE_SUPABASE_URL. Using SUPABASE_URL for router.');
}
