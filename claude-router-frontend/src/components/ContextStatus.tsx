// src/components/ContextStatus.tsx
import React from 'react';

// Define the shape of the contextStatus prop
interface ContextStatusProps {
  contextStatus: {
    utilizationPercent: number;
    tokenEstimate: number;
    messageCount?: number; // Optional based on your usage
  } | null;
}

export const ContextStatus: React.FC<ContextStatusProps> = ({ contextStatus }) => {
  if (!contextStatus) return null;

  const { utilizationPercent, tokenEstimate } = contextStatus;
  
  // Determine color based on usage
  let statusColor = '#4ECDC4'; // Green
  if (utilizationPercent > 50) statusColor = '#FFD93D'; // Yellow
  if (utilizationPercent > 80) statusColor = '#FF6B6B'; // Red

  return (
    <div className="context-status" style={{ 
      display: 'flex', 
      alignItems: 'center', 
      gap: '8px',
      fontSize: '0.8rem',
      color: 'rgba(255,255,255,0.7)',
      padding: '4px 8px',
      background: 'rgba(255,255,255,0.05)',
      borderRadius: '4px',
      border: `1px solid ${statusColor}40`
    }}>
      <div className="status-indicator">
        <div 
          className="status-dot" 
          style={{ 
            width: '8px', 
            height: '8px', 
            borderRadius: '50%', 
            backgroundColor: statusColor,
            boxShadow: `0 0 8px ${statusColor}60`
          }} 
        />
      </div>
      <span>{Math.round(utilizationPercent)}% Context ({tokenEstimate.toLocaleString()} tokens)</span>
    </div>
  );
};