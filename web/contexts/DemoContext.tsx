'use client';

import { createContext, useContext } from 'react';
import type { DemoSparklineData, DemoDisplayState } from '@/lib/demo-data';
import type { ChartDataPoint } from '@/hooks/useHistoricalMetrics';
import type { TimeRange } from '@/components/charts/TimeRangeSelector';

interface DemoContextType {
  isDemo: true;
  getSparklineData: (machineId: string) => DemoSparklineData;
  getHistoricalData: (machineId: string, timeRange: TimeRange) => ChartDataPoint[];
  getDisplayState: (machineId: string) => DemoDisplayState;
}

export const DemoContext = createContext<DemoContextType | null>(null);

export function useDemoContext() {
  return useContext(DemoContext);
}
