// src/components/ChatInterface.tsx
// Main chat interface with multi-file upload support and model selector

import React, { useState, useRef, useEffect } from 'react';
import { useContextManager } from '../hooks/useContextManager';
import { ContextWarning } from './ContextWarning';
import { ContextStatus } from './ContextStatus';
import { FileUpload } from './FileUpload';
import { askClaude, resetConversation } from '../smartFetch';
import { uploadAttachment } from '../services/storageService';
import type { Message, RouterModel, FileUploadPayload } from '../types';
import type { User } from '@supabase/supabase-js';

interface ChatInterfaceProps {
  user: User | null;
  onSignOut: () => Promise<void>;
}

// Model configuration
const MODEL_CONFIG: Record<RouterModel, { name: string; icon: string; description: string; color: string }> = {
  'opus-4.5': {
    name: 'Claude Opus 4.5',
    icon: '🧠',
    description: 'Deep research',
    color: '#FF6B6B'
  },
  'sonnet-4.5': {
    name: 'Claude Sonnet 4.5',
    icon: '⚡',
    description: 'Balanced performance & coding',
    color: '#4ECDC4'
  },
  'haiku-4.5': {
    name: 'Claude Haiku 4.5',
    icon: '🚀',
    description: 'Fast & efficient',
    color: '#FFE66D'
  },
  'gpt-5-mini': {
    name: 'GPT-5 mini',
    icon: '🧩',
    description: 'Low-latency general tasks',
    color: '#F4A261'
  },
  'gemini-3-flash': {
    name: 'Gemini 3 Flash',
    icon: '✨',
    description: 'Fast multimodal inference',
    color: '#2A9D8F'
  },
  'gemini-3-pro': {
    name: 'Gemini 3 Pro',
    icon: '🔬',
    description: 'Advanced multimodal reasoning',
    color: '#1D3557'
  }
};

export const ChatInterface: React.FC<ChatInterfaceProps> = ({ user, onSignOut }) => {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [currentModel, setCurrentModel] = useState<RouterModel>('sonnet-4.5');
  const [currentComplexity, setCurrentComplexity] = useState<number>(50);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showModelSelector, setShowModelSelector] = useState(false);
  const [manualModelOverride, setManualModelOverride] = useState<RouterModel | null>(null);
  
  // ✅ FIX: Changed from single attachment to ARRAY of attachments
  const [draftAttachments, setDraftAttachments] = useState<FileUploadPayload[]>([]);

  // Context Manager
  const {
    contextStatus,
    shouldShowWarning,
    createNewChatWithContext
  } = useContextManager(messages, true);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const modelSelectorRef = useRef<HTMLDivElement>(null);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, draftAttachments]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setShowUserMenu(false);
      }
      if (modelSelectorRef.current && !modelSelectorRef.current.contains(e.target as Node)) {
        setShowModelSelector(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Auto-resize textarea
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
  };

  // ✅ FIX: Handle single file - ADD to array instead of replace
  const handleFileSelect = (file: FileUploadPayload) => {
    console.log('[ChatInterface] File added:', file.name, file.isImage ? 'image' : 'text');
    setDraftAttachments(prev => [...prev, file]);
    inputRef.current?.focus();
  };

  // ✅ FIX: Handle multiple files at once - ADD all to array
  const handleMultipleFiles = (files: FileUploadPayload[]) => {
    console.log('[ChatInterface] Multiple files added:', files.length);
    setDraftAttachments(prev => [...prev, ...files]);
    inputRef.current?.focus();
  };

  // ✅ FIX: Remove specific attachment by index
  const removeAttachment = (index: number) => {
    setDraftAttachments(prev => prev.filter((_, i) => i !== index));
  };

  // Clear all attachments
  const clearAllAttachments = () => {
    setDraftAttachments([]);
  };

  // Handle model selection
  const handleModelSelect = (model: RouterModel) => {
    setManualModelOverride(model);
    setCurrentModel(model);
    setShowModelSelector(false);
  };

  // Clear manual override (let router decide)
  const clearModelOverride = () => {
    setManualModelOverride(null);
    setShowModelSelector(false);
  };

  const handleSend = async () => {
    // Allow send if there's text OR attachments
    const hasContent = input.trim() || draftAttachments.length > 0;
    if (!hasContent || isStreaming) return;

    // Build query text
    const hasImages = draftAttachments.some(f => f.isImage);
    const hasTextFiles = draftAttachments.some(f => !f.isImage);
    
    let queryText = input.trim();
    
    // If no text but has attachments, use default prompts
    if (!queryText) {
      if (hasImages && hasTextFiles) {
        queryText = 'Analyze these files and images.';
      } else if (hasImages) {
        queryText = draftAttachments.length === 1 ? 'Analyze this image.' : 'Analyze these images.';
      } else if (hasTextFiles) {
        queryText = 'Process these files.';
      }
    }

    // Build display content for user message
    const attachmentSummary = draftAttachments.length > 0
      ? `[${draftAttachments.length} file${draftAttachments.length > 1 ? 's' : ''} attached]`
      : '';

    // Prepare user message for display
    const userMessage: Message = {
      role: 'user',
      content: input.trim() || attachmentSummary,
      timestamp: Date.now(),
      // Store first image for display (UI limitation)
      ...(draftAttachments.find(f => f.isImage)?.imageData && {
        imageData: draftAttachments.find(f => f.isImage)?.imageData,
        mediaType: draftAttachments.find(f => f.isImage)?.mediaType
      }),
      // Store all attachments for reference
      attachments: draftAttachments.length > 0 ? [...draftAttachments] : undefined
    };

    setMessages(prev => [...prev, userMessage]);

    // Clear inputs
    setInput('');
    const attachmentsToProcess = [...draftAttachments];
    setDraftAttachments([]);
    if (inputRef.current) inputRef.current.style.height = 'auto';

    setIsStreaming(true);

    try {
      // Upload image attachments (graceful failure)
      const storageUrls: string[] = [];
      if (user) {
        for (const attachment of attachmentsToProcess) {
          if (attachment.isImage && attachment.imageData) {
            try {
              const url = await uploadAttachment(attachment, user.id);
              if (url) storageUrls.push(url);
            } catch (uploadError) {
              console.warn('[ChatInterface] Storage upload failed (non-blocking):', uploadError);
            }
          }
        }
      }

      // ✅ FIX: Pass array of attachments to askClaude
      const result = await askClaude(
        queryText,
        messages,
        attachmentsToProcess, // Now passing array!
        manualModelOverride
      );

      if (!result) throw new Error('Failed to get response from router');

      const { stream, model, provider, complexityScore, modelId, modelOverride: appliedOverride } = result;

      // âœ… FIX: Only update model if no manual override is active
      // This prevents the backend response from overwriting the user's manual selection
      if (!manualModelOverride) {
        setCurrentModel(model);
      }
      setCurrentComplexity(complexityScore);

      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let assistantContent = '';

      setMessages(prev => [...prev, {
        role: 'assistant',
        content: '',
        model,
        provider,
        modelId,
        modelOverride: appliedOverride,
        timestamp: Date.now()
      }]);

      // Stream loop
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.trim()) {
            try {
              if (line.startsWith('data: ')) {
                const json = JSON.parse(line.slice(6));
                if (json.type === 'content_block_delta') {
                  assistantContent += json.delta?.text || '';
                }
              } else if (!line.startsWith('event:')) {
                assistantContent += line;
              }
            } catch {
              // Ignore partial JSON
            }
          }
        }

        setMessages(prev => {
          const updated = [...prev];
          const lastMessage = updated[updated.length - 1];
          if (lastMessage) {
            updated[updated.length - 1] = {
              ...lastMessage,
              content: assistantContent
            };
          }
          return updated;
        });
      }

    } catch (error) {
      console.error('Stream error:', error);
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `⚠️ Error: ${error instanceof Error ? error.message : 'Unknown error occurred'}`,
        timestamp: Date.now()
      }]);
    } finally {
      setIsStreaming(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleReset = () => {
    if (confirm('Reset conversation? This will clear all messages.')) {
      setMessages([]);
      resetConversation();
      setCurrentModel('sonnet-4.5');
      setCurrentComplexity(50);
      setDraftAttachments([]);
      setManualModelOverride(null);
    }
  };

  const handleSignOut = async () => {
    setShowUserMenu(false);
    await onSignOut();
  };

  const getUserDisplay = () => {
    if (!user) return '';
    return user.user_metadata?.full_name || user.email?.split('@')[0] || 'User';
  };

  const modelConfig = MODEL_CONFIG[currentModel];

  return (
    <div className="chat-container">
      {/* Header */}
      <header className="chat-header">
        <div className="header-content">
          <div className="header-title">
            <h1>Claude Router</h1>
            <span className="header-subtitle">Intelligent Model Selection</span>
          </div>
          <div className="header-actions">
            {contextStatus && <ContextStatus contextStatus={contextStatus} />}
            
            {/* Model Selector - CLICKABLE */}
            <div className="model-selector-container" ref={modelSelectorRef}>
              <button
                type="button"
                className="model-indicator-button"
                onClick={() => setShowModelSelector(!showModelSelector)}
                style={{ '--model-color': modelConfig.color } as React.CSSProperties}
                title={manualModelOverride ? `Manual: ${modelConfig.name}` : `Auto: ${modelConfig.name}`}
              >
                <span className="model-icon">{modelConfig.icon}</span>
                <div className="model-info">
                  <span className="model-name">{modelConfig.name}</span>
                  <span className="model-description">{modelConfig.description}</span>
                </div>
                <div className="complexity-score">
                  <div className="complexity-bar">
                    <div 
                      className="complexity-fill"
                      style={{ width: `${currentComplexity}%` }}
                    />
                  </div>
                  <span className="complexity-label">{currentComplexity}</span>
                </div>
                {manualModelOverride && <span className="manual-badge">Manual</span>}
                {isStreaming && <div className="model-pulse" />}
              </button>

              {/* Model Dropdown */}
              {showModelSelector && (
                <div className="model-dropdown">
                  <div className="dropdown-header">
                    <span>Select Model</span>
                    {manualModelOverride && (
                      <button 
                        type="button" 
                        className="auto-mode-btn"
                        onClick={clearModelOverride}
                      >
                        Use Auto
                      </button>
                    )}
                  </div>
                  <div className="model-options">
                    {(Object.entries(MODEL_CONFIG) as [RouterModel, typeof MODEL_CONFIG['sonnet-4.5']][]).map(([key, config]) => (
                      <button
                        key={key}
                        type="button"
                        className={`model-option ${currentModel === key ? 'active' : ''} ${manualModelOverride === key ? 'manual' : ''}`}
                        onClick={() => handleModelSelect(key)}
                        style={{ '--option-color': config.color } as React.CSSProperties}
                      >
                        <span className="option-icon">{config.icon}</span>
                        <div className="option-info">
                          <span className="option-name">{config.name.replace('Claude ', '')}</span>
                          <span className="option-desc">{config.description}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={handleReset}
              className="header-button"
              title="Reset conversation"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                <path d="M21 3v5h-5" />
                <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
                <path d="M3 21v-5h5" />
              </svg>
            </button>
            
            {/* User Menu */}
            <div className="user-menu-container" ref={userMenuRef}>
              <button
                type="button"
                onClick={() => setShowUserMenu(!showUserMenu)}
                className="user-button"
                title={user?.email || 'User menu'}
              >
                <span className="user-avatar">
                  {getUserDisplay().charAt(0).toUpperCase()}
                </span>
              </button>
              
              {showUserMenu && (
                <div className="user-dropdown">
                  <div className="user-info">
                    <span className="user-name">{getUserDisplay()}</span>
                    <span className="user-email">{user?.email}</span>
                  </div>
                  <div className="dropdown-divider" />
                  <button type="button" onClick={handleSignOut} className="dropdown-item">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                      <polyline points="16 17 21 12 16 7" />
                      <line x1="21" y1="12" x2="9" y2="12" />
                    </svg>
                    Sign Out
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Context Warning */}
      {shouldShowWarning && contextStatus && (
        <ContextWarning
          contextStatus={contextStatus}
          onNewChat={() => {
            createNewChatWithContext();
            setMessages([]);
            resetConversation();
          }}
        />
      )}

      {/* Messages Area */}
      <main className="chat-messages">
        {messages.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">🤖</div>
            <h2>Welcome, {getUserDisplay()}!</h2>
            <p>The router will automatically select the best model based on your query complexity</p>
            <div className="model-grid">
              {(Object.entries(MODEL_CONFIG) as [RouterModel, typeof MODEL_CONFIG['sonnet-4.5']][]).map(([key, config]) => (
                <div 
                  key={key} 
                  className="model-card"
                  style={{ '--card-color': config.color } as React.CSSProperties}
                >
                  <span className="card-icon">{config.icon}</span>
                  <span className="card-name">{config.name.replace('Claude ', '')}</span>
                  <span className="card-desc">{config.description}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="messages-list">
            {messages.map((msg, idx) => (
              <div key={idx} className={`message message-${msg.role}`}>
                <div className="message-avatar">
                  {msg.role === 'user' ? '👤' : '🤖'}
                </div>
                <div className="message-content">
                  <div className="message-header">
                    <span className="message-role">
                      {msg.role === 'user' ? 'You' : 'Assistant'}
                    </span>
                    {msg.model && (
                      <span className="message-model" title={msg.modelId || msg.model}>
                        {msg.modelId || msg.model}
                      </span>
                    )}
                    {msg.provider && (
                      <span className="message-model-override">{msg.provider}</span>
                    )}
                    {msg.modelOverride && msg.modelOverride !== 'auto' && (
                      <span className="message-model-override">manual</span>
                    )}
                    <span className="message-time">
                      {new Date(msg.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                  {/* Render images if present */}
                  {msg.imageData && (
                    <div className="message-image-container">
                      <img 
                        src={`data:${msg.mediaType || 'image/png'};base64,${msg.imageData}`}
                        alt="Uploaded content"
                        className="message-image"
                      />
                    </div>
                  )}
                  {/* Show attachment count if multiple */}
                  {(msg as any).attachments?.length > 1 && (
                    <div className="message-attachments-badge">
                      📎 {(msg as any).attachments.length} files attached
                    </div>
                  )}
                  <div className="message-text">
                    {typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)}
                    {isStreaming && idx === messages.length - 1 && msg.role === 'assistant' && (
                      <span className="cursor-blink">▊</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </main>

      {/* Input Area */}
      <div className="chat-input-container">
        <div className="input-wrapper">
          {/* ✅ FIX: Multi-file preview */}
          {draftAttachments.length > 0 && (
            <div className="draft-preview-container">
              <div className="draft-preview-header">
                <span>{draftAttachments.length} file{draftAttachments.length > 1 ? 's' : ''} attached</span>
                <button 
                  type="button"
                  onClick={clearAllAttachments}
                  className="clear-all-btn"
                  title="Remove all attachments"
                >
                  Clear all
                </button>
              </div>
              <div className="draft-files-list">
                {draftAttachments.map((file, index) => (
                  <div key={index} className="draft-file-item">
                    {file.isImage && file.imageData ? (
                      <img 
                        src={`data:${file.mediaType};base64,${file.imageData}`}
                        alt={file.name}
                        className="draft-thumbnail"
                      />
                    ) : (
                      <div className="draft-file-icon">📄</div>
                    )}
                    <span className="draft-filename" title={file.name}>
                      {file.name.length > 20 ? file.name.slice(0, 17) + '...' : file.name}
                    </span>
                    <button 
                      type="button"
                      onClick={() => removeAttachment(index)}
                      className="draft-remove-btn"
                      title="Remove this file"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Input Row */}
          <div className="input-row">
            {/* ✅ FIX: Now passing BOTH handlers */}
            <FileUpload 
              onFileContent={handleFileSelect}
              onMultipleFiles={handleMultipleFiles}
              disabled={isStreaming}
              maxFiles={10}
            />
            <textarea
              ref={inputRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder={draftAttachments.length > 0 ? "Add a message (optional)..." : "Ask anything... (Shift+Enter for new line)"}
              className="chat-input"
              disabled={isStreaming}
              rows={1}
            />
            <button
              type="button"
              onClick={handleSend}
              disabled={(!input.trim() && draftAttachments.length === 0) || isStreaming}
              className="send-button"
              title="Send message"
            >
              {isStreaming ? (
                <div className="loading-spinner" />
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>

      <style>{`
        .chat-container {
          display: flex;
          flex-direction: column;
          height: 100vh;
          background: #0a0a0a;
          font-family: 'Berkeley Mono', 'JetBrains Mono', 'Fira Code', monospace;
          color: #fff;
        }

        .chat-header {
          background: rgba(10, 10, 10, 0.95);
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
          padding: 1rem 1.5rem;
          backdrop-filter: blur(20px);
          position: sticky;
          top: 0;
          z-index: 100;
        }

        .header-content {
          max-width: 1400px;
          margin: 0 auto;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 1rem;
        }

        .header-title h1 {
          margin: 0;
          font-size: 1.25rem;
          font-weight: 600;
          background: linear-gradient(135deg, #fff, #4ECDC4);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
        }

        .header-subtitle {
          font-size: 0.75rem;
          color: rgba(255, 255, 255, 0.5);
          text-transform: uppercase;
          letter-spacing: 0.1em;
        }

        .header-actions { display: flex; align-items: center; gap: 0.75rem; }

        .header-button {
          width: 40px; height: 40px;
          border-radius: 0.5rem;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.1);
          color: rgba(255, 255, 255, 0.6);
          cursor: pointer;
          transition: all 0.2s;
          display: flex; align-items: center; justify-content: center;
        }

        .header-button:hover { background: rgba(255, 255, 255, 0.1); color: #fff; }

        .model-selector-container { position: relative; }

        .model-indicator-button {
          display: flex; align-items: center; gap: 0.75rem;
          padding: 0.5rem 1rem;
          background: rgba(0, 0, 0, 0.6);
          border: 1px solid var(--model-color);
          border-radius: 0.5rem;
          cursor: pointer;
          transition: all 0.3s ease;
          position: relative;
          color: inherit;
        }

        .model-indicator-button:hover {
          background: rgba(0, 0, 0, 0.8);
          box-shadow: 0 0 20px rgba(78, 205, 196, 0.2);
        }

        .model-icon { font-size: 1.25rem; }
        .model-info { display: flex; flex-direction: column; gap: 0.125rem; text-align: left; }
        .model-name { font-size: 0.875rem; font-weight: 600; color: var(--model-color); }
        .model-description { font-size: 0.7rem; color: rgba(255, 255, 255, 0.6); }

        .complexity-score { display: flex; flex-direction: column; align-items: flex-end; gap: 0.25rem; }
        .complexity-bar { width: 60px; height: 4px; background: rgba(255, 255, 255, 0.1); border-radius: 2px; overflow: hidden; }
        .complexity-fill { height: 100%; background: var(--model-color); transition: width 0.5s ease; }
        .complexity-label { font-size: 0.65rem; font-weight: 600; color: var(--model-color); }

        .manual-badge {
          position: absolute; top: -6px; right: -6px;
          background: #FF6B6B; color: #fff;
          font-size: 0.6rem; padding: 2px 6px;
          border-radius: 4px; font-weight: 600;
        }

        .model-pulse {
          position: absolute; inset: -2px;
          border: 2px solid var(--model-color);
          border-radius: 0.5rem;
          animation: pulse 2s ease-in-out infinite;
          pointer-events: none;
        }

        .model-dropdown {
          position: absolute; top: calc(100% + 8px); right: 0;
          background: rgba(20, 20, 20, 0.98);
          border: 1px solid rgba(255, 255, 255, 0.15);
          border-radius: 0.75rem;
          padding: 0.75rem;
          min-width: 280px;
          box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
          z-index: 1000;
          animation: dropdownIn 0.2s ease;
        }

        .dropdown-header {
          display: flex; justify-content: space-between; align-items: center;
          padding: 0 0.5rem 0.75rem;
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
          margin-bottom: 0.75rem;
          font-size: 0.8rem;
          color: rgba(255, 255, 255, 0.6);
        }

        .auto-mode-btn {
          background: rgba(78, 205, 196, 0.15);
          border: 1px solid rgba(78, 205, 196, 0.3);
          color: #4ECDC4;
          padding: 4px 10px;
          border-radius: 4px;
          font-size: 0.7rem;
          cursor: pointer;
        }

        .model-options { display: flex; flex-direction: column; gap: 0.5rem; }

        .model-option {
          display: flex; align-items: center; gap: 0.75rem;
          padding: 0.75rem;
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 0.5rem;
          cursor: pointer;
          transition: all 0.2s;
          text-align: left;
          color: inherit;
          width: 100%;
        }

        .model-option:hover { background: rgba(255, 255, 255, 0.08); border-color: var(--option-color); }
        .model-option.active { background: rgba(255, 255, 255, 0.05); border-color: var(--option-color); }
        .model-option.manual { box-shadow: 0 0 0 2px var(--option-color); }

        .option-icon { font-size: 1.5rem; }
        .option-info { display: flex; flex-direction: column; gap: 2px; }
        .option-name { font-weight: 600; font-size: 0.85rem; color: var(--option-color); }
        .option-desc { font-size: 0.7rem; color: rgba(255, 255, 255, 0.5); }

        .user-menu-container { position: relative; }

        .user-button {
          width: 40px; height: 40px;
          border-radius: 50%;
          background: linear-gradient(135deg, #4ECDC4, #44A3B3);
          border: none; cursor: pointer;
          display: flex; align-items: center; justify-content: center;
        }

        .user-avatar { font-size: 1rem; font-weight: 600; color: #fff; }

        .user-dropdown {
          position: absolute; top: calc(100% + 8px); right: 0;
          background: rgba(20, 20, 20, 0.98);
          border: 1px solid rgba(255, 255, 255, 0.15);
          border-radius: 0.75rem;
          padding: 0.5rem;
          min-width: 200px;
          box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
          z-index: 1000;
        }

        .user-info { padding: 0.75rem; display: flex; flex-direction: column; gap: 0.25rem; }
        .user-name { font-weight: 600; color: #fff; }
        .user-email { font-size: 0.75rem; color: rgba(255, 255, 255, 0.5); }
        .dropdown-divider { height: 1px; background: rgba(255, 255, 255, 0.1); margin: 0.25rem 0; }

        .dropdown-item {
          display: flex; align-items: center; gap: 0.75rem;
          width: 100%; padding: 0.75rem;
          background: transparent; border: none;
          border-radius: 0.5rem;
          color: rgba(255, 255, 255, 0.8);
          cursor: pointer;
          font-family: inherit; font-size: 0.875rem;
        }

        .dropdown-item:hover { background: rgba(255, 107, 107, 0.1); color: #FF6B6B; }

        .chat-messages { flex: 1; overflow-y: auto; padding: 1.5rem; }

        .empty-state {
          display: flex; flex-direction: column;
          align-items: center; justify-content: center;
          height: 100%; text-align: center;
          color: rgba(255, 255, 255, 0.7);
        }

        .empty-icon { font-size: 4rem; margin-bottom: 1rem; }
        .empty-state h2 { margin: 0 0 0.5rem; font-size: 1.5rem; }
        .empty-state p { margin: 0 0 2rem; color: rgba(255, 255, 255, 0.5); max-width: 400px; }

        .model-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; max-width: 600px; }

        .model-card {
          display: flex; flex-direction: column; align-items: center; gap: 0.5rem;
          padding: 1.25rem 1rem;
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 0.75rem;
          transition: all 0.3s ease;
        }

        .model-card:hover { border-color: var(--card-color); transform: translateY(-4px); }
        .card-icon { font-size: 2rem; }
        .card-name { font-weight: 600; color: var(--card-color); }
        .card-desc { font-size: 0.75rem; color: rgba(255, 255, 255, 0.5); }

        .messages-list { max-width: 900px; margin: 0 auto; display: flex; flex-direction: column; gap: 1.5rem; }

        .message { display: flex; gap: 1rem; animation: slideIn 0.3s ease; }

        .message-avatar {
          width: 40px; height: 40px;
          border-radius: 0.625rem;
          display: flex; align-items: center; justify-content: center;
          font-size: 1.25rem; flex-shrink: 0;
        }

        .message-user .message-avatar { background: rgba(78, 205, 196, 0.1); border: 1px solid rgba(78, 205, 196, 0.3); }
        .message-assistant .message-avatar { background: rgba(255, 107, 107, 0.1); border: 1px solid rgba(255, 107, 107, 0.3); }

        .message-content { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.5rem; }
        .message-header { display: flex; align-items: center; gap: 0.75rem; font-size: 0.8rem; }
        .message-role { font-weight: 600; color: #fff; }
        .message-model { padding: 0.125rem 0.5rem; background: rgba(255, 255, 255, 0.05); border-radius: 0.25rem; font-size: 0.7rem; text-transform: uppercase; }
        .message-model-override {
          padding: 0.125rem 0.4rem;
          background: rgba(255, 107, 107, 0.15);
          border: 1px solid rgba(255, 107, 107, 0.4);
          border-radius: 0.25rem;
          font-size: 0.65rem;
          text-transform: uppercase;
          color: #FF6B6B;
        }
        .message-time { color: rgba(255, 255, 255, 0.4); margin-left: auto; }

        .message-image-container { margin: 0.5rem 0; max-width: 300px; }
        .message-image { max-width: 100%; max-height: 300px; border-radius: 0.5rem; border: 1px solid rgba(255, 255, 255, 0.1); }

        .message-attachments-badge {
          font-size: 0.75rem; color: rgba(78, 205, 196, 0.8);
          padding: 0.25rem 0.5rem;
          background: rgba(78, 205, 196, 0.1);
          border-radius: 0.25rem;
          width: fit-content;
        }

        .message-text { line-height: 1.6; color: rgba(255, 255, 255, 0.9); white-space: pre-wrap; word-break: break-word; }
        .cursor-blink { animation: blink 1s step-end infinite; color: #4ECDC4; }

        .chat-input-container {
          background: rgba(20, 20, 20, 0.95);
          border-top: 1px solid rgba(255, 255, 255, 0.1);
          padding: 1.25rem 1.5rem;
        }

        .input-wrapper { max-width: 900px; margin: 0 auto; display: flex; flex-direction: column; gap: 0.75rem; }

        .draft-preview-container {
          background: rgba(78, 205, 196, 0.08);
          border: 1px solid rgba(78, 205, 196, 0.2);
          border-radius: 0.625rem;
          padding: 0.75rem;
        }

        .draft-preview-header {
          display: flex; justify-content: space-between; align-items: center;
          margin-bottom: 0.5rem;
          font-size: 0.8rem;
          color: rgba(255, 255, 255, 0.7);
        }

        .clear-all-btn {
          background: transparent;
          border: 1px solid rgba(255, 107, 107, 0.3);
          color: #FF6B6B;
          padding: 0.25rem 0.5rem;
          border-radius: 0.25rem;
          font-size: 0.7rem;
          cursor: pointer;
        }

        .draft-files-list { display: flex; flex-wrap: wrap; gap: 0.5rem; }

        .draft-file-item {
          display: flex; align-items: center; gap: 0.5rem;
          padding: 0.375rem 0.5rem;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 0.375rem;
        }

        .draft-thumbnail { width: 28px; height: 28px; border-radius: 0.25rem; object-fit: cover; }
        .draft-file-icon { width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; }
        .draft-filename { font-size: 0.75rem; color: rgba(255, 255, 255, 0.8); max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

        .draft-remove-btn {
          background: transparent; border: none;
          color: rgba(255, 255, 255, 0.4);
          cursor: pointer;
          padding: 0.25rem;
          border-radius: 0.25rem;
        }

        .draft-remove-btn:hover { background: rgba(255, 107, 107, 0.2); color: #FF6B6B; }

        .input-row { display: flex; gap: 0.625rem; align-items: flex-end; }

        .chat-input {
          flex: 1;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 0.75rem;
          padding: 0.875rem 1rem;
          color: #fff;
          font-family: inherit; font-size: 0.95rem;
          resize: none;
          min-height: 48px; max-height: 200px;
        }

        .chat-input:focus { outline: none; background: rgba(255, 255, 255, 0.08); border-color: rgba(78, 205, 196, 0.5); }
        .chat-input:disabled { opacity: 0.5; }
        .chat-input::placeholder { color: rgba(255, 255, 255, 0.4); }

        .send-button {
          width: 48px; height: 48px;
          border-radius: 0.75rem;
          background: linear-gradient(135deg, #4ECDC4, #44A3B3);
          border: none; color: #fff; cursor: pointer;
          display: flex; align-items: center; justify-content: center;
        }

        .send-button:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 8px 16px rgba(78, 205, 196, 0.3); }
        .send-button:disabled { opacity: 0.5; cursor: not-allowed; }

        .loading-spinner { width: 20px; height: 20px; border: 2px solid rgba(255, 255, 255, 0.3); border-top-color: #fff; border-radius: 50%; animation: spin 0.8s linear infinite; }

        @keyframes dropdownIn { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes slideIn { from { opacity: 0; transform: translateX(-20px); } to { opacity: 1; transform: translateX(0); } }
        @keyframes blink { 0%, 50% { opacity: 1; } 51%, 100% { opacity: 0; } }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0% { transform: scale(1); opacity: 1; } 100% { transform: scale(1.1); opacity: 0; } }

        @media (max-width: 768px) {
          .chat-header { padding: 0.75rem 1rem; }
          .header-content { flex-direction: column; align-items: stretch; }
          .header-actions { width: 100%; justify-content: space-between; flex-wrap: wrap; }
          .model-selector-container { flex: 1 1 100%; }
          .model-indicator-button { width: 100%; justify-content: space-between; }
          .user-menu-container { margin-left: auto; flex-shrink: 0; }
          .model-dropdown { right: 0; left: 0; width: calc(100vw - 2rem); max-width: 360px; }
          .model-grid { grid-template-columns: 1fr; max-width: 200px; }
          .model-info { display: none; }
        }
      `}</style>
    </div>
  );
};
