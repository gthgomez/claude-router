// ModelIndicator.tsx - Visual indicator for active router model

import React from 'react';
import { MODEL_CATALOG } from './modelCatalog';
import type { RouterModel } from './types';

interface ModelIndicatorProps {
  model: RouterModel;
  complexityScore?: number;
  isLoading?: boolean;
}

export const ModelIndicator: React.FC<ModelIndicatorProps> = ({ 
  model, 
  complexityScore,
  isLoading = false 
}) => {
  const modelConfig = MODEL_CATALOG[model];

  return (
    <div 
      className="model-indicator"
      style={{
        '--model-color': modelConfig.color
      } as React.CSSProperties}
    >
      <div className="model-badge">
        <span className="model-icon">{modelConfig.icon}</span>
        <div className="model-info">
          <span className="model-name">{modelConfig.name}</span>
          <span className="model-description">{modelConfig.description}</span>
        </div>
        {complexityScore !== undefined && (
          <div className="complexity-score">
            <div className="complexity-bar">
              <div 
                className="complexity-fill"
                style={{ width: `${complexityScore}%` }}
              />
            </div>
            <span className="complexity-label">{complexityScore}</span>
          </div>
        )}
      </div>
      {isLoading && <div className="model-pulse" />}
      
      <style>{`
        .model-indicator {
          position: relative;
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
        }

        .model-badge {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          padding: 0.5rem 1rem;
          background: rgba(0, 0, 0, 0.6);
          border: 1px solid var(--model-color);
          border-radius: 0.5rem;
          backdrop-filter: blur(10px);
          transition: all 0.3s ease;
        }

        .model-badge:hover {
          background: rgba(0, 0, 0, 0.8);
          box-shadow: 0 0 20px rgba(var(--model-color-rgb), 0.3);
        }

        .model-icon {
          font-size: 1.25rem;
          animation: float 3s ease-in-out infinite;
        }

        .model-info {
          display: flex;
          flex-direction: column;
          gap: 0.125rem;
        }

        .model-name {
          font-size: 0.875rem;
          font-weight: 600;
          color: var(--model-color);
          letter-spacing: 0.025em;
        }

        .model-description {
          font-size: 0.75rem;
          color: rgba(255, 255, 255, 0.6);
        }

        .complexity-score {
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 0.25rem;
        }

        .complexity-bar {
          width: 60px;
          height: 4px;
          background: rgba(255, 255, 255, 0.1);
          border-radius: 2px;
          overflow: hidden;
        }

        .complexity-fill {
          height: 100%;
          background: var(--model-color);
          transition: width 0.5s ease;
          box-shadow: 0 0 10px var(--model-color);
        }

        .complexity-label {
          font-size: 0.65rem;
          font-weight: 600;
          color: var(--model-color);
          font-variant-numeric: tabular-nums;
        }

        .model-pulse {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          width: 100%;
          height: 100%;
          border: 2px solid var(--model-color);
          border-radius: 0.5rem;
          animation: pulse 2s ease-in-out infinite;
          pointer-events: none;
        }

        @keyframes float {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-4px); }
        }

        @keyframes pulse {
          0% {
            transform: translate(-50%, -50%) scale(1);
            opacity: 1;
          }
          100% {
            transform: translate(-50%, -50%) scale(1.1);
            opacity: 0;
          }
        }
      `}</style>
    </div>
  );
};
