import React from 'react';

export interface BudgetDecision {
  blocked: boolean;
  requiresConfirm: boolean;
  reason?: string;
}

export function evaluateBudget(params: {
  estimateUsd: number;
  dailyTotalUsd: number;
  dailyLimitUsd: number;
}): BudgetDecision {
  const estimateUsd = Math.max(0, params.estimateUsd);
  const dailyTotalUsd = Math.max(0, params.dailyTotalUsd);
  const dailyLimitUsd = Math.max(0, params.dailyLimitUsd);

  if (dailyTotalUsd + estimateUsd > dailyLimitUsd) {
    return {
      blocked: true,
      requiresConfirm: false,
      reason: `Daily budget exceeded ($${dailyTotalUsd.toFixed(2)} + $${estimateUsd.toFixed(2)} > $${dailyLimitUsd.toFixed(2)}). Try Gemini 3 Flash.`,
    };
  }

  if (estimateUsd > 0.5) {
    return { blocked: false, requiresConfirm: true };
  }

  return { blocked: false, requiresConfirm: false };
}

interface BudgetGuardProps {
  isOpen: boolean;
  estimateUsd: number;
  dailyTotalUsd: number;
  dailyLimitUsd: number;
  onCancel: () => void;
  onConfirm: () => void;
}

export const BudgetGuard: React.FC<BudgetGuardProps> = ({
  isOpen,
  estimateUsd,
  dailyTotalUsd,
  dailyLimitUsd,
  onCancel,
  onConfirm,
}) => {
  if (!isOpen) return null;

  return (
    <div className='budget-guard-overlay' role='dialog' aria-modal='true'>
      <div className='budget-guard-modal'>
        <h3>High-Cost Message Warning</h3>
        <p>This request is estimated at <strong>${estimateUsd.toFixed(4)}</strong>.</p>
        <p>Daily spend after send: ${(dailyTotalUsd + estimateUsd).toFixed(4)} / ${dailyLimitUsd.toFixed(2)}</p>
        <div className='budget-guard-actions'>
          <button type='button' onClick={onCancel}>Cancel</button>
          <button type='button' onClick={onConfirm}>Send Anyway</button>
        </div>
      </div>
    </div>
  );
};
