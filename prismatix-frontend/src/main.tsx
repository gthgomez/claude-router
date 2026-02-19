// main.tsx - Application entry point

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/mobile.css';

// Verify environment variables on startup
const requiredEnvVars = ['VITE_SUPABASE_ANON_KEY'];
const missingVars = requiredEnvVars.filter(
  varName => !import.meta.env[varName]
);

if (missingVars.length > 0) {
  console.error(
    '❌ Missing required environment variables:',
    missingVars.join(', ')
  );
  console.error('Create a .env file based on .env.example');
}

// Mount React app
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
