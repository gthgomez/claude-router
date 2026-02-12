import React, { useEffect, useRef, useState } from 'react';
import { CONFIG } from '../config';
import { supabase } from '../lib/supabase';

interface SpendTrackerProps {
  refreshKey: number;
}

interface SpendStats {
  today: number;
  thisWeek: number;
  thisMonth: number;
  allTime: number;
  lastMessageCost: number;
  messageCount: number;
}

const EMPTY_STATS: SpendStats = {
  today: 0,
  thisWeek: 0,
  thisMonth: 0,
  allTime: 0,
  lastMessageCost: 0,
  messageCount: 0,
};

export const SpendTracker: React.FC<SpendTrackerProps> = ({ refreshKey }) => {
  const [stats, setStats] = useState<SpendStats>(EMPTY_STATS);
  const [isOpen, setIsOpen] = useState(false);
  const [syncState, setSyncState] = useState<'idle' | 'syncing' | 'error'>('idle');
  const [syncMessage, setSyncMessage] = useState('');
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const refreshCycleRef = useRef(0);
  const refreshTimersRef = useRef<number[]>([]);
  const widgetRef = useRef<HTMLDivElement | null>(null);

  const fetchServerStats = async (): Promise<SpendStats | null> => {
    const {
      data: { session },
      error: sessionError,
    } = await supabase.auth.getSession();

    if (sessionError || !session?.access_token || !CONFIG.SUPABASE_URL) {
      return null;
    }

    try {
      const base = CONFIG.SUPABASE_URL.replace(/\/$/, '');
      const endpoints = [
        `${base}/functions/v1/spend-stats`,
        `${base}/functions/v1/spend_stats`,
      ];

      for (const endpoint of endpoints) {
        const response = await fetch(endpoint, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            ...(CONFIG.SUPABASE_ANON_KEY ? { apikey: CONFIG.SUPABASE_ANON_KEY } : {}),
          },
        });

        if (!response.ok) continue;

        const data = await response.json() as SpendStats;
        return {
          today: Number(data.today) || 0,
          thisWeek: Number(data.thisWeek) || 0,
          thisMonth: Number(data.thisMonth) || 0,
          allTime: Number(data.allTime) || 0,
          lastMessageCost: Number(data.lastMessageCost) || 0,
          messageCount: Number(data.messageCount) || 0,
        };
      }

      return null;
    } catch {
      return null;
    }
  };

  const refreshStats = async () => {
    setSyncState('syncing');
    setSyncMessage('');

    const serverStats = await fetchServerStats();
    if (serverStats) {
      setStats(serverStats);
      setSyncState('idle');
      setLastSyncAt(Date.now());
      return;
    }

    setSyncState('error');
    setSyncMessage('Unable to sync spend right now.');
  };

  useEffect(() => {
    refreshCycleRef.current += 1;
    const cycleId = refreshCycleRef.current;

    for (const timeoutId of refreshTimersRef.current) {
      window.clearTimeout(timeoutId);
    }
    refreshTimersRef.current = [];

    // Poll a few times after refresh requests to absorb eventual DB consistency.
    const retryDelaysMs = [0, 450, 1200, 2500];
    for (const delay of retryDelaysMs) {
      const timeoutId = window.setTimeout(() => {
        if (refreshCycleRef.current !== cycleId) return;
        void refreshStats();
      }, delay);
      refreshTimersRef.current.push(timeoutId);
    }

    return () => {
      for (const timeoutId of refreshTimersRef.current) {
        window.clearTimeout(timeoutId);
      }
      refreshTimersRef.current = [];
    };
  }, [refreshKey]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (!widgetRef.current) return;
      if (!widgetRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div className='spend-widget' ref={widgetRef}>
      <button
        type='button'
        className='spend-pill'
        onClick={() => setIsOpen((prev) => !prev)}
        aria-expanded={isOpen}
        title='View spend analytics'
      >
        <span className='spend-pill-value'>${stats.today.toFixed(2)}</span>
        <span className='spend-pill-label'>Today</span>
        <span
          className={`spend-pill-state ${
            syncState === 'syncing' ? 'syncing' : syncState === 'error' ? 'error' : 'idle'
          }`}
        >
          {syncState === 'syncing' ? 'Syncing' : syncState === 'error' ? 'Sync issue' : 'Live'}
        </span>
      </button>

      {isOpen && (
        <aside className='spend-popover'>
          <h3>Spend Analytics</h3>
          <div className='spend-grid'>
            <div className='spend-card'>
              <div className='spend-label'>Today</div>
              <div className='spend-value'>${stats.today.toFixed(4)}</div>
            </div>
            <div className='spend-card'>
              <div className='spend-label'>This Week</div>
              <div className='spend-value'>${stats.thisWeek.toFixed(4)}</div>
            </div>
            <div className='spend-card'>
              <div className='spend-label'>This Month</div>
              <div className='spend-value'>${stats.thisMonth.toFixed(4)}</div>
            </div>
            <div className='spend-card'>
              <div className='spend-label'>All Time</div>
              <div className='spend-value'>${stats.allTime.toFixed(4)}</div>
            </div>
          </div>
          <div className='spend-last'>
            <div>Last message: ${stats.lastMessageCost.toFixed(6)}</div>
            <div>{stats.messageCount} messages logged</div>
          </div>
          <div className='spend-sync-note'>
            {syncState === 'syncing' && 'Syncing latest totals...'}
            {syncState === 'error' && syncMessage}
            {syncState === 'idle' && lastSyncAt &&
              `Last synced ${new Date(lastSyncAt).toLocaleTimeString()}`}
          </div>
        </aside>
      )}
    </div>
  );
};
