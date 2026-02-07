// config.ts - Configuration and environment variables

export const CONFIG = {
  // Supabase Configuration
  SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL || 'https://sqjfbqjogylkfwzsyprd.supabase.co',
  SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY || '',
  
  // Router Endpoint
  ROUTER_ENDPOINT: import.meta.env.VITE_ROUTER_ENDPOINT || 
    'https://sqjfbqjogylkfwzsyprd.functions.supabase.co/router',
  
  // Platform Detection
  PLATFORM: (() => {
    const ua = navigator.userAgent;
    if (/Android|iPhone|iPad|iPod/i.test(ua)) return 'mobile';
    if (/Electron/i.test(ua)) return 'desktop';
    return 'web';
  })() as 'web' | 'mobile' | 'desktop',
  
  // Model Configuration
  MODELS: {
    'opus-4.5': {
      name: 'Claude Opus 4.5',
      color: '#FF6B6B',
      description: 'Deep research & complex reasoning',
      icon: '🧠'
    },
    'sonnet-4.5': {
      name: 'Claude Sonnet 4.5',
      color: '#4ECDC4',
      description: 'Balanced performance & coding',
      icon: '⚡'
    },
    'haiku-4.5': {
      name: 'Claude Haiku 4.5',
      color: '#95E1D3',
      description: 'Fast & efficient responses',
      icon: '🚀'
    }
  }
} as const;

// Validate required config
if (!CONFIG.SUPABASE_ANON_KEY) {
  console.warn('⚠️ VITE_SUPABASE_ANON_KEY not set. Router requests will fail.');
}
