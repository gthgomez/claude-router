import React, { useState } from 'react';

interface ThinkingProcessProps {
  thoughts?: string[];
  elapsedMs?: number;
}

export const ThinkingProcess: React.FC<ThinkingProcessProps> = ({ thoughts = [], elapsedMs }) => {
  const [collapsed, setCollapsed] = useState(true);

  if (!thoughts.length) return null;

  const seconds = elapsedMs ? `${(elapsedMs / 1000).toFixed(1)}s` : null;

  return (
    <div className='thinking-process'>
      <button type='button' className='thinking-process-header' onClick={() => setCollapsed((prev) => !prev)}>
        <span>Thinking Process{seconds ? ` (${seconds})` : ''}</span>
        <span>{collapsed ? '+' : '-'}</span>
      </button>
      {!collapsed && (
        <pre className='thinking-process-content'>
          {thoughts.join('')}
        </pre>
      )}
    </div>
  );
};
