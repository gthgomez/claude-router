// utils.ts - Utility functions for Claude Router Frontend

import type { Message, ClaudeModel } from './types';

/**
 * Formats timestamp to readable time
 */
export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

/**
 * Formats timestamp to readable date and time
 */
export function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  const isToday = date.toDateString() === today.toDateString();
  
  if (isToday) {
    return `Today at ${formatTime(timestamp)}`;
  }
  
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

/**
 * Estimates token count (rough approximation)
 */
export function estimateTokens(text: string): number {
  // Rough estimate: 1 token ≈ 4 characters
  return Math.ceil(text.length / 4);
}

/**
 * Calculates total tokens in conversation history
 */
export function calculateHistoryTokens(messages: Message[]): number {
  return messages.reduce((total, msg) => {
    const contentText = typeof msg.content === 'string' 
      ? msg.content 
      : JSON.stringify(msg.content);
      
    return total + estimateTokens(contentText);
  }, 0);
}

/**
 * Determines if conversation is approaching context limit
 */
export function isNearContextLimit(messages: Message[], limit: number = 150000): boolean {
  const totalTokens = calculateHistoryTokens(messages);
  return totalTokens > limit * 0.8; // 80% threshold
}

/**
 * Exports conversation to JSON
 */
export function exportConversation(messages: Message[]): string {
  const data = {
    exported_at: new Date().toISOString(),
    message_count: messages.length,
    total_tokens: calculateHistoryTokens(messages),
    messages: messages.map(msg => ({
      role: msg.role,
      content: msg.content,
      model: msg.model,
      timestamp: msg.timestamp
    }))
  };
  
  return JSON.stringify(data, null, 2);
}

/**
 * Downloads conversation as JSON file
 */
export function downloadConversation(messages: Message[]): void {
  const json = exportConversation(messages);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = `claude-conversation-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Copies text to clipboard
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    console.error('Failed to copy to clipboard:', error);
    return false;
  }
}

/**
 * Detects code blocks in text
 */
export function detectCodeBlocks(text: string): boolean {
  return /```[\s\S]*```/.test(text);
}

/**
 * Extracts language from code block
 */
export function extractCodeLanguage(codeBlock: string): string {
  const match = codeBlock.match(/```(\w+)/);
  return (match && match[1]) ? match[1] : 'plaintext';
}

/**
 * Sanitizes HTML to prevent XSS
 */
export function sanitizeHTML(html: string): string {
  const div = document.createElement('div');
  div.textContent = html;
  return div.innerHTML;
}

/**
 * Gets model color for UI theming
 */
export function getModelColor(model: ClaudeModel): string {
  const colors = {
    'opus-4.5': '#FF6B6B',
    'sonnet-4.5': '#4ECDC4',
    'haiku-4.5': '#95E1D3'
  };
  return colors[model] || '#4ECDC4';
}

/**
 * Gets model emoji icon
 */
export function getModelIcon(model: ClaudeModel): string {
  const icons = {
    'opus-4.5': '🧠',
    'sonnet-4.5': '⚡',
    'haiku-4.5': '🚀'
  };
  return icons[model] || '⚡';
}

/**
 * Validates conversation ID format
 */
export function isValidConversationId(id: string): boolean {
  return /^conv_\d+_[a-z0-9]+$/.test(id);
}

/**
 * Debounces a function
 */
export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  
  return (...args: Parameters<T>) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}

/**
 * Throttles a function
 */
export function throttle<T extends (...args: any[]) => any>(
  func: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle: boolean = false;
  
  return (...args: Parameters<T>) => {
    if (!inThrottle) {
      func(...args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  };
}

/**
 * Detects if user is on mobile device
 */
export function isMobileDevice(): boolean {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent
  );
}

/**
 * Gets platform-specific keyboard shortcut text
 */
export function getKeyboardShortcut(): string {
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  return isMac ? '⌘ + Enter' : 'Ctrl + Enter';
}

/**
 * Formats large numbers with commas
 */
export function formatNumber(num: number): string {
  return num.toLocaleString('en-US');
}

/**
 * Calculates reading time for content
 */
export function calculateReadingTime(text: string): number {
  const wordsPerMinute = 200;
  const wordCount = text.split(/\s+/).length;
  return Math.ceil(wordCount / wordsPerMinute);
}

/**
 * Truncates text to specified length
 */
export function truncate(text: string, maxLength: number, suffix: string = '...'): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - suffix.length) + suffix;
}
