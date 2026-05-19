/**
 * Charts Components
 *
 * Reusable charting components for the Owlette dashboard.
 * Built with Recharts for performance and flexibility.
 */

export { SparklineChart } from './SparklineChart';
export type { SparklineDataPoint, MetricColor } from './SparklineChart';

export { TimeRangeSelector, getTimeRangeStart, getTimeRangeLabel } from './TimeRangeSelector';
export type { TimeRange } from './TimeRangeSelector';

export { ChartTooltip, metricConfig } from './ChartTooltip';
export type { MetricType } from './ChartTooltip';

export { MetricsDetailPanel } from './MetricsDetailPanel';

// Re-exported from the lightweight pure-utils module so importers don't pay the
// cost of loading Recharts just to build a persisted tab-id list at click time.
export { initialMetricToState, serializeTabs } from './metricsTabs';
export type { TabSelection } from './metricsTabs';
