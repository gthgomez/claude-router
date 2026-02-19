// src/hooks/useContextManager.ts
import { useState, useEffect } from 'react';
import { ContextManager } from '../services/contextManager.ts'; // Added .ts
import type { Message } from '../types.ts'; // Added .ts

// Define the event detail type
export interface AutoContextEvent extends CustomEvent {
  detail: { createNewChatWithContext: () => string };
}

export function useContextManager(messages: Message[], autoCreate = false) {
    const [contextManager] = useState(() => new ContextManager());
    const [contextStatus, setContextStatus] = useState<ReturnType<ContextManager['analyzeConversation']> | null>(null);
    const [shouldShowWarning, setShouldShowWarning] = useState(false);

    useEffect(() => {
        const analysis = contextManager.analyzeConversation(messages);
        setContextStatus(analysis);
        setShouldShowWarning(analysis.utilizationPercent > 80);
        
        // Automatic context creation logic
        if (autoCreate && analysis.shouldReset && messages.length > 0) {
            const timer = setTimeout(() => {
                const event = new CustomEvent('autoContextReset', {
                    detail: { createNewChatWithContext }
                }) as AutoContextEvent;
                globalThis.dispatchEvent(event); // Replaced window with globalThis
            }, 1000);
            return () => clearTimeout(timer);
        }
        // Explicit return for consistent code paths
        return undefined;
    }, [messages, contextManager, autoCreate]);

    const generateContextDoc = () => {
        return contextManager.generateContextSummary(messages);
    };

    const createNewChatWithContext = () => {
        const contextDoc = generateContextDoc();
        // Format the summary for the AI
        const contextMessage = `## Previous Chat Context
**Summary**: ${contextDoc.summary}
**Key Decisions**: ${contextDoc.keyDecisions.join('; ')}
**Last Few Topics**: ${contextDoc.recentContext.map((c: { preview: string }) => c.preview).join(' | ')}
**Previous Message Count**: ${contextDoc.messageCount}

Please continue our conversation with this context in mind.`;

        return contextMessage;
    };

    return {
        contextStatus,
        shouldShowWarning,
        generateContextDoc,
        createNewChatWithContext
    };
}