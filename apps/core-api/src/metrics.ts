type Counters = {
  requests: number;
  errors: number;
  latency_ms_sum: number;
};

const totals: Counters = { requests: 0, errors: 0, latency_ms_sum: 0 };
const buckets = { b50: 0, b200: 0, b1000: 0, bInf: 0 };
let executions = 0;

export function recordRequest(status: number, latencyMs: number, route?: string): void {
  totals.requests += 1;
  if (status >= 400) {
    totals.errors += 1;
  }
  totals.latency_ms_sum += latencyMs;
  if (latencyMs <= 50) buckets.b50 += 1;
  else if (latencyMs <= 200) buckets.b200 += 1;
  else if (latencyMs <= 1000) buckets.b1000 += 1;
  else buckets.bInf += 1;
  if (route?.includes("/executions") || route?.includes("/nova/skills")) {
    executions += 1;
  }
}

export function metricsSnapshot() {
  return {
    requests: totals.requests,
    errors: totals.errors,
    executions,
    latency_ms_avg: totals.requests ? Math.round(totals.latency_ms_sum / totals.requests) : 0,
    latency_buckets: { le_50: buckets.b50, le_200: buckets.b200, le_1000: buckets.b1000, inf: buckets.bInf },
  };
}
