import React, { useMemo } from 'react';
import { calculateCostBreakdown, type UsageEstimate } from '../costEngine';
import type { RouterModel } from '../types';

interface CostEstimatorProps {
  model: RouterModel;
  usage: UsageEstimate | null;
  isVisible: boolean;
  isStreaming: boolean;
  totalCost: number;
  finalCostUsd: number | null;
}

export const CostEstimator: React.FC<CostEstimatorProps> = ({
  model,
  usage,
  isVisible,
  isStreaming,
  totalCost,
  finalCostUsd,
}) => {
  const breakdown = useMemo(() => {
    if (!usage) {
      return {
        inputCost: 0,
        outputCost: 0,
        thinkingCost: 0,
        totalCost: 0,
      };
    }

    return calculateCostBreakdown(model, usage);
  }, [model, usage]);

  if (!isVisible) return null;

  const messageTotal = isStreaming
    ? breakdown.totalCost
    : (finalCostUsd ?? breakdown.totalCost);
  const sessionTotalDisplay = isStreaming
    ? totalCost + messageTotal
    : totalCost;

  return (
    <div
      className={`cost-estimator ${isStreaming ? 'streaming' : 'final'}`}
      aria-live='polite'
    >
      <div className='cost-estimator-title'>{isStreaming ? 'This Message' : 'Final Total'}</div>
      <div className='cost-estimator-rows'>
        <div className='cost-estimator-row'>
          <span>Input</span>
          <span>${breakdown.inputCost.toFixed(6)}</span>
        </div>
        <div className='cost-estimator-row'>
          <span>Output</span>
          <span>${breakdown.outputCost.toFixed(6)}</span>
        </div>
        {breakdown.thinkingCost > 0 && (
          <div className='cost-estimator-row'>
            <span>Thinking</span>
            <span>${breakdown.thinkingCost.toFixed(6)}</span>
          </div>
        )}
        <div className='cost-estimator-total'>
          <span>Total</span>
          <span>${messageTotal.toFixed(6)}</span>
        </div>
      </div>
      <div className='cost-estimator-session'>
        <span>Session Total</span>
        <strong>${sessionTotalDisplay.toFixed(4)}</strong>
      </div>
      {!isStreaming && <div className='cost-estimator-final-note'>Hiding...</div>}
    </div>
  );
};
