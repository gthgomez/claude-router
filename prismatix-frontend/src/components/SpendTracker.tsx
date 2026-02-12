import React, { useEffect, useState } from 'react';
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
    const serverStats = await fetchServerStats();
    if (serverStats) {
      setStats(serverStats);
      return;
    }

    setStats(EMPTY_STATS);
  };

  useEffect(() => {
    void refreshStats();
  }, [refreshKey]);

  return (
    <aside className='spend-tracker'>
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
    </aside>
  );
};
