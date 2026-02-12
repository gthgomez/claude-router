import React from 'react';
import type { MessageCost } from '../types';

interface CostBadgeProps {
  cost?: MessageCost;
}

export const CostBadge: React.FC<CostBadgeProps> = ({ cost }) => {
  if (!cost) return null;

  const value = cost.finalUsd ?? cost.estimatedUsd;
  if (value === undefined) return null;

  const label = cost.finalUsd !== undefined ? 'final' : 'est';

  return (
    <span className='message-model-override' title={cost.pricingVersion || 'cost'}>
      ${value.toFixed(4)} {label}
    </span>
  );
};
