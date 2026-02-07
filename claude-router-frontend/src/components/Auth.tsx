// src/components/Auth.tsx
// Authentication UI component with L3 Safety Gates

import React, { useState } from 'react';

interface AuthProps {
  onSignIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  onSignUp: (email: string, password: string) => Promise<{ error: Error | null }>;
  onSignInWithProvider?: (provider: 'google' | 'github') => Promise<{ error: Error | null }>;
}

type AuthMode = 'signin' | 'signup';

export const Auth: React.FC<AuthProps> = ({ 
  onSignIn, 
  onSignUp, 
  onSignInWithProvider 
}) => {
  const [mode, setMode] = useState<AuthMode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMessage(null);

    // L3 Gate: Validate inputs
    if (!email.trim()) {
      setError('Email is required');
      return;
    }

    if (!password) {
      setError('Password is required');
      return;
    }

    if (mode === 'signup') {
      if (password.length < 6) {
        setError('Password must be at least 6 characters');
        return;
      }
      if (password !== confirmPassword) {
        setError('Passwords do not match');
        return;
      }
    }

    setIsLoading(true);

    try {
      const result = mode === 'signin' 
        ? await onSignIn(email, password)
        : await onSignUp(email, password);

      if (result.error) {
        setError(result.error.message);
      } else if (mode === 'signup') {
        setSuccessMessage('Check your email to confirm your account!');
        setMode('signin');
      }
    } catch (err) {
      setError('An unexpected error occurred');
    } finally {
      setIsLoading(false);
    }
  };

  const handleProviderSignIn = async (provider: 'google' | 'github') => {
    if (!onSignInWithProvider) return;
    
    setError(null);
    setIsLoading(true);

    try {
      const result = await onSignInWithProvider(provider);
      if (result.error) {
        setError(result.error.message);
      }
    } catch (err) {
      setError('An unexpected error occurred');
    } finally {
      setIsLoading(false);
    }
  };

  const toggleMode = () => {
    setMode(mode === 'signin' ? 'signup' : 'signin');
    setError(null);
    setSuccessMessage(null);
    setConfirmPassword('');
  };

  return (
    <div className="auth-container">
      <div className="auth-card">
        {/* Header */}
        <div className="auth-header">
          <div className="auth-logo">🤖</div>
          <h1>Claude Router</h1>
          <p>Intelligent Model Selection</p>
        </div>

        {/* Tab Switcher */}
        <div className="auth-tabs">
          <button 
            type="button"
            className={`auth-tab ${mode === 'signin' ? 'active' : ''}`}
            onClick={() => setMode('signin')}
          >
            Sign In
          </button>
          <button 
            type="button"
            className={`auth-tab ${mode === 'signup' ? 'active' : ''}`}
            onClick={() => setMode('signup')}
          >
            Sign Up
          </button>
        </div>

        {/* Messages */}
        {error && (
          <div className="auth-message error">
            <span>⚠️</span> {error}
          </div>
        )}
        {successMessage && (
          <div className="auth-message success">
            <span>✓</span> {successMessage}
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="auth-form">
          <div className="form-group">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              disabled={isLoading}
              autoComplete="email"
            />
          </div>

          <div className="form-group">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              disabled={isLoading}
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            />
          </div>

          {mode === 'signup' && (
            <div className="form-group">
              <label htmlFor="confirmPassword">Confirm Password</label>
              <input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="••••••••"
                disabled={isLoading}
                autoComplete="new-password"
              />
            </div>
          )}

          <button 
            type="submit" 
            className="auth-submit"
            disabled={isLoading}
          >
            {isLoading ? (
              <div className="loading-spinner" />
            ) : (
              mode === 'signin' ? 'Sign In' : 'Create Account'
            )}
          </button>
        </form>

        {/* OAuth Providers */}
        {onSignInWithProvider && (
          <>
            <div className="auth-divider">
              <span>or continue with</span>
            </div>

            <div className="auth-providers">
              <button 
                type="button"
                className="provider-button google"
                onClick={() => handleProviderSignIn('google')}
                disabled={isLoading}
              >
                <svg viewBox="0 0 24 24" width="20" height="20">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
                Google
              </button>

              <button 
                type="button"
                className="provider-button github"
                onClick={() => handleProviderSignIn('github')}
                disabled={isLoading}
              >
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
                </svg>
                GitHub
              </button>
            </div>
          </>
        )}

        {/* Footer */}
        <div className="auth-footer">
          <p>
            {mode === 'signin' ? "Don't have an account? " : "Already have an account? "}
            <button type="button" onClick={toggleMode} className="auth-link">
              {mode === 'signin' ? 'Sign Up' : 'Sign In'}
            </button>
          </p>
        </div>
      </div>

      <style>{`
        .auth-container {
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          background: #0a0a0a;
          padding: 2rem;
          font-family: 'Berkeley Mono', 'JetBrains Mono', 'Fira Code', monospace;
        }

        .auth-card {
          width: 100%;
          max-width: 420px;
          background: rgba(20, 20, 20, 0.95);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 1rem;
          padding: 2rem;
          backdrop-filter: blur(20px);
          animation: fadeIn 0.5s ease;
        }

        .auth-header {
          text-align: center;
          margin-bottom: 2rem;
        }

        .auth-logo {
          font-size: 3rem;
          margin-bottom: 1rem;
          animation: float 3s ease-in-out infinite;
        }

        .auth-header h1 {
          font-size: 1.75rem;
          font-weight: 700;
          background: linear-gradient(135deg, #4ECDC4, #FF6B6B);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
          margin: 0 0 0.5rem 0;
        }

        .auth-header p {
          color: rgba(255, 255, 255, 0.5);
          font-size: 0.875rem;
          margin: 0;
          text-transform: uppercase;
          letter-spacing: 0.1em;
        }

        .auth-tabs {
          display: flex;
          gap: 0.5rem;
          margin-bottom: 1.5rem;
          background: rgba(255, 255, 255, 0.03);
          border-radius: 0.5rem;
          padding: 0.25rem;
        }

        .auth-tab {
          flex: 1;
          padding: 0.75rem;
          background: transparent;
          border: none;
          border-radius: 0.375rem;
          color: rgba(255, 255, 255, 0.5);
          font-family: inherit;
          font-size: 0.875rem;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
        }

        .auth-tab:hover {
          color: rgba(255, 255, 255, 0.8);
        }

        .auth-tab.active {
          background: rgba(78, 205, 196, 0.2);
          color: #4ECDC4;
        }

        .auth-message {
          padding: 0.75rem 1rem;
          border-radius: 0.5rem;
          margin-bottom: 1rem;
          font-size: 0.875rem;
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }

        .auth-message.error {
          background: rgba(255, 107, 107, 0.1);
          border: 1px solid rgba(255, 107, 107, 0.3);
          color: #FF6B6B;
        }

        .auth-message.success {
          background: rgba(78, 205, 196, 0.1);
          border: 1px solid rgba(78, 205, 196, 0.3);
          color: #4ECDC4;
        }

        .auth-form {
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }

        .form-group {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }

        .form-group label {
          font-size: 0.8rem;
          color: rgba(255, 255, 255, 0.7);
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }

        .form-group input {
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 0.5rem;
          padding: 0.875rem 1rem;
          color: #fff;
          font-family: inherit;
          font-size: 0.95rem;
          transition: all 0.2s;
        }

        .form-group input:focus {
          outline: none;
          background: rgba(255, 255, 255, 0.08);
          border-color: rgba(78, 205, 196, 0.5);
          box-shadow: 0 0 0 3px rgba(78, 205, 196, 0.1);
        }

        .form-group input::placeholder {
          color: rgba(255, 255, 255, 0.3);
        }

        .form-group input:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .auth-submit {
          margin-top: 0.5rem;
          padding: 1rem;
          background: linear-gradient(135deg, #4ECDC4, #44A3B3);
          border: none;
          border-radius: 0.5rem;
          color: #fff;
          font-family: inherit;
          font-size: 1rem;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 52px;
        }

        .auth-submit:hover:not(:disabled) {
          transform: translateY(-2px);
          box-shadow: 0 8px 20px rgba(78, 205, 196, 0.3);
        }

        .auth-submit:disabled {
          opacity: 0.7;
          cursor: not-allowed;
        }

        .auth-divider {
          display: flex;
          align-items: center;
          gap: 1rem;
          margin: 1.5rem 0;
          color: rgba(255, 255, 255, 0.3);
          font-size: 0.8rem;
        }

        .auth-divider::before,
        .auth-divider::after {
          content: '';
          flex: 1;
          height: 1px;
          background: rgba(255, 255, 255, 0.1);
        }

        .auth-providers {
          display: flex;
          gap: 0.75rem;
        }

        .provider-button {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 0.5rem;
          padding: 0.875rem;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 0.5rem;
          color: #fff;
          font-family: inherit;
          font-size: 0.875rem;
          cursor: pointer;
          transition: all 0.2s;
        }

        .provider-button:hover:not(:disabled) {
          background: rgba(255, 255, 255, 0.1);
          border-color: rgba(255, 255, 255, 0.2);
        }

        .provider-button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .auth-footer {
          margin-top: 1.5rem;
          text-align: center;
        }

        .auth-footer p {
          color: rgba(255, 255, 255, 0.5);
          font-size: 0.875rem;
          margin: 0;
        }

        .auth-link {
          background: none;
          border: none;
          color: #4ECDC4;
          font-family: inherit;
          font-size: inherit;
          cursor: pointer;
          text-decoration: underline;
        }

        .auth-link:hover {
          color: #5FE0D7;
        }

        .loading-spinner {
          width: 20px;
          height: 20px;
          border: 2px solid rgba(255, 255, 255, 0.3);
          border-top-color: #fff;
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
        }

        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
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
};
