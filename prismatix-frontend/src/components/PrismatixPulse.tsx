import React from 'react';

interface PrismatixPulseProps {
  color: string;
}

export const PrismatixPulse: React.FC<PrismatixPulseProps> = ({ color }) => {
  return (
    <div className='prismatix-pulse-track'>
      <div className='prismatix-pulse-fill' style={{ '--pulse-color': color } as React.CSSProperties} />
    </div>
  );
};
