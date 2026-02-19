// src/services/contextManager.ts
import type { Message } from '../types.ts';

export interface ContextAnalysis {
  messageCount: number;
  tokenEstimate: number;
  utilizationPercent: number;
  shouldReset: boolean;
  summary?: string;
  keyDecisions: string[];
  recentContext: { role: string; preview: string }[];
}

export class ContextManager {
  private readonly MAX_CONTEXT_TOKENS = 200000; // approx for frontier model context windows
  private readonly WARNING_THRESHOLD = 0.8; // 80%

  constructor() {}

  /**
   * Roughly estimates token count (4 chars ~= 1 token)
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  public analyzeConversation(messages: Message[]): ContextAnalysis {
    let totalTokens = 0;
    
    // Calculate total tokens with multimodal content support
    messages.forEach(msg => {
      const contentText = typeof msg.content === 'string' 
        ? msg.content 
        : JSON.stringify(msg.content); // Convert arrays to string for estimation
      totalTokens += this.estimateTokens(contentText);
    });

    const utilization = totalTokens / this.MAX_CONTEXT_TOKENS;

    // Get last 3 messages for "recent context" with multimodal handling
    const recent = messages.slice(-3).map(m => {
      const text = typeof m.content === 'string' 
        ? m.content 
        : '[Multimodal Content]';
      return {
        role: m.role,
        preview: text.substring(0, 50) + (text.length > 50 ? '...' : '')
      };
    });

    return {
      messageCount: messages.length,
      tokenEstimate: totalTokens,
      utilizationPercent: utilization * 100,
      shouldReset: utilization > this.WARNING_THRESHOLD,
      keyDecisions: [], // Placeholder for real logic
      recentContext: recent
    };
  }

  public generateContextSummary(messages: Message[]): ContextAnalysis {
    // Re-run analysis to get current stats
    const analysis = this.analyzeConversation(messages);
    
    // Add summary logic
    return {
      ...analysis,
      summary: `Conversation with ${messages.length} messages.`,
      keyDecisions: ['User requested context preservation']
    };
  }
}
