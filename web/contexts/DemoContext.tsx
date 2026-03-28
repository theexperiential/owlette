'use client';

import { createContext, useContext } from 'react';
import type { DemoSparklineData } from '@/lib/demo-data';
import type { ChartDataPoint } from '@/hooks/useHistoricalMetrics';
import type { TimeRange } from '@/components/charts/TimeRangeSelector';

interface DemoContextType {
  isDemo: true;
  getSparklineData: (machineId: string) => DemoSparklineData;
  getHistoricalData: (machineId: string, timeRange: TimeRange) => ChartDataPoint[];
}

export const DemoContext = createContext<DemoContextType | null>(null);

export function useDemoContext() {
  return useContext(DemoContext);
}
