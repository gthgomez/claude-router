// src/components/ContextWarning.tsx
import React from 'react';

interface ContextWarningProps {
    contextStatus: {
        shouldReset: boolean;
        utilizationPercent: number;
        messageCount: number;
        tokenEstimate: number; // Corrected name
    } | null;
    onNewChat: () => void;
}

export const ContextWarning: React.FC<ContextWarningProps> = ({ contextStatus, onNewChat }) => {
    if (!contextStatus?.shouldReset) return null;

    return (
        <div className="bg-yellow-100 border-l-4 border-yellow-500 p-4 mb-4">
            <div className="flex justify-between items-center">
                <div>
                    <p className="text-sm text-yellow-700">
                        Context getting long ({contextStatus.utilizationPercent}% capacity)
                        <br />
                        {contextStatus.messageCount} messages, ~{contextStatus.tokenEstimate} tokens
                    </p>
                </div>
                <button
                    type="button"
                    onClick={onNewChat}
                    className="bg-yellow-500 text-white px-4 py-2 rounded text-sm"
                >
                    Start New Chat with Context
                </button>
            </div>
        </div>
    );
};