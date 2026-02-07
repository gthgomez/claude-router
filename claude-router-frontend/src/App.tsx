// App.tsx - Root component with authentication gating
// Auth state managed at root level for proper lifecycle management

import React from 'react';
import { ChatInterface } from './components/ChatInterface';
import { Auth } from './components/Auth';
import { useAuth } from './hooks/useAuth';

function App() {
  const { 
    isAuthenticated, 
    isLoading, 
    user,
    signIn, 
    signUp, 
    signOut,
    signInWithProvider 
  } = useAuth();

  // Loading state while checking auth
  if (isLoading) {
    return (
      <div className="app loading-screen">
        <div className="loading-content">
          <div className="loading-logo">🤖</div>
          <div className="loading-spinner-large" />
          <p>Initializing Claude Router...</p>
        </div>

        <style>{`
          .loading-screen {
            height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background: #0a0a0a;
            font-family: 'Berkeley Mono', 'JetBrains Mono', 'Fira Code', monospace;
          }

          .loading-content {
            text-align: center;
            color: rgba(255, 255, 255, 0.7);
          }

          .loading-logo {
            font-size: 4rem;
            margin-bottom: 1.5rem;
            animation: float 3s ease-in-out infinite;
          }

          .loading-spinner-large {
            width: 40px;
            height: 40px;
            margin: 0 auto 1rem;
            border: 3px solid rgba(78, 205, 196, 0.2);
            border-top-color: #4ECDC4;
            border-radius: 50%;
            animation: spin 1s linear infinite;
          }

          .loading-content p {
            font-size: 0.9rem;
            color: rgba(255, 255, 255, 0.5);
          }

          @keyframes float {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-10px); }
          }

          @keyframes spin {
            to { transform: rotate(360deg); }
          }
        `}</style>
      </div>
    );
  }

  // Not authenticated - show login
  if (!isAuthenticated) {
    return (
      <div className="app">
        <Auth 
          onSignIn={signIn}
          onSignUp={signUp}
          onSignInWithProvider={signInWithProvider}
        />

        <style>{`
          html, body, #root {
            margin: 0;
            padding: 0;
            height: 100%;
            overflow: hidden;
          }

          .app {
            height: 100%;
            width: 100%;
          }

          @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap');
        `}</style>
      </div>
    );
  }

  // Authenticated - show chat interface
  return (
    <div className="app">
      <ChatInterface 
        user={user}
        onSignOut={signOut}
      />

      <style>{`
        html, body, #root {
          margin: 0;
          padding: 0;
          height: 100%;
          overflow: hidden;
        }

        .app {
          height: 100%;
          width: 100%;
        }

        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap');
      `}</style>
    </div>
  );
}

export default App;
