// ===== Mock Data cho màn Analysis Dashboard =====

// ---- KPI Cards ----
export interface KPIData {
  totalRequests: number;
  p95Latency: number; // ms
  errorRate: number; // percentage
  uptime: number; // percentage
  // Trend so với kỳ trước (dương = tăng, âm = giảm)
  totalRequestsChange: number;
  p95LatencyChange: number;
  errorRateChange: number;
  uptimeChange: number;
}

export const kpiData: KPIData = {
  totalRequests: 2847392,
  p95Latency: 247,
  errorRate: 1.8,
  uptime: 99.97,
  totalRequestsChange: 12.5,
  p95LatencyChange: -5.2,
  errorRateChange: 0.3,
  uptimeChange: 0.01,
};

// ---- Line Chart: Request Volume theo thời gian (24h, mỗi điểm 15 phút) ----
export interface TimeSeriesPoint {
  time: string; // HH:mm
  GET: number;
  POST: number;
  PUT: number;
  DELETE: number;
}

function generateRequestVolume(): TimeSeriesPoint[] {
  const data: TimeSeriesPoint[] = [];
  for (let hour = 0; hour < 24; hour++) {
    for (let min = 0; min < 60; min += 15) {
      const time = `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
      // Mô phỏng traffic cao điểm giờ hành chính (8h-18h)
      const peakMultiplier = hour >= 8 && hour <= 18 ? 2.5 : 1;
      data.push({
        time,
        GET: Math.floor((800 + Math.random() * 400) * peakMultiplier),
        POST: Math.floor((200 + Math.random() * 150) * peakMultiplier),
        PUT: Math.floor((80 + Math.random() * 60) * peakMultiplier),
        DELETE: Math.floor((30 + Math.random() * 40) * peakMultiplier),
      });
    }
  }
  return data;
}

export const requestVolumeData: TimeSeriesPoint[] = generateRequestVolume();

// ---- Pie Chart: HTTP Status Code Distribution ----
export interface StatusCodeItem {
  code: number;
  label: string;
  count: number;
  color: string;
}

export const statusCodeData: StatusCodeItem[] = [
  { code: 200, label: "200 OK", count: 2415283, color: "#22c55e" },
  { code: 201, label: "201 Created", count: 156840, color: "#3b82f6" },
  { code: 204, label: "204 No Content", count: 89215, color: "#6366f1" },
  { code: 400, label: "400 Bad Request", count: 34210, color: "#f59e0b" },
  { code: 401, label: "401 Unauthorized", count: 12500, color: "#f97316" },
  { code: 404, label: "404 Not Found", count: 18340, color: "#ef4444" },
  { code: 500, label: "500 Server Error", count: 11004, color: "#dc2626" },
];

// Grouped status code data cho toggle xem nhóm

export const groupedStatusCodeData: StatusCodeItem[] = [
  { code: 0, label: "2xx Success", count: 2661338, color: "#22c55e" },
  { code: 0, label: "4xx Client Error", count: 65050, color: "#f59e0b" },
  { code: 0, label: "5xx Server Error", count: 11004, color: "#ef4444" },
];

export const totalRequestCount: number = statusCodeData.reduce((sum, item) => sum + item.count, 0);

// Threshold cho latency warning (ms)
export const LATENCY_THRESHOLD_P95 = 500;

// ---- Bar Chart: Response Time theo Endpoint ----
export interface EndpointLatency {
  endpoint: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  p50: number;
  p95: number;
  p99: number;
}

export const endpointLatencyData: EndpointLatency[] = [
  { endpoint: "/api/users", method: "GET", p50: 45, p95: 120, p99: 310 },
  { endpoint: "/api/users", method: "POST", p50: 120, p95: 380, p99: 720 },
  { endpoint: "/api/orders", method: "GET", p50: 55, p95: 180, p99: 450 },
  { endpoint: "/api/orders", method: "POST", p50: 140, p95: 420, p99: 890 },
  { endpoint: "/api/products", method: "GET", p50: 35, p95: 95, p99: 240 },
  { endpoint: "/api/products", method: "PUT", p50: 100, p95: 310, p99: 680 },
  { endpoint: "/api/auth/login", method: "POST", p50: 180, p95: 550, p99: 1100 },
  { endpoint: "/api/auth/refresh", method: "POST", p50: 60, p95: 160, p99: 350 },
  { endpoint: "/api/analytics", method: "GET", p50: 210, p95: 620, p99: 1350 },
  { endpoint: "/api/export", method: "GET", p50: 520, p95: 1850, p99: 4200 },
];

// ---- Stacked Area Chart: Traffic by Route Group theo thời gian ----
export interface RouteTrafficPoint {
  time: string;
  "User & Auth": number;
  "Orders": number;
  "Products": number;
  "Analytics": number;
  "Other": number;
}

export function generateRouteTraffic(): RouteTrafficPoint[] {
  const data: RouteTrafficPoint[] = [];
  for (let hour = 0; hour < 24; hour++) {
    for (let min = 0; min < 60; min += 30) {
      const time = `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
      const peakMultiplier = hour >= 8 && hour <= 18 ? 2.5 : 1;
      data.push({
        time,
        "User & Auth": Math.floor((300 + Math.random() * 200) * peakMultiplier),
        Orders: Math.floor((200 + Math.random() * 150) * peakMultiplier),
        Products: Math.floor((150 + Math.random() * 120) * peakMultiplier),
        Analytics: Math.floor((80 + Math.random() * 70) * peakMultiplier),
        Other: Math.floor((100 + Math.random() * 80) * peakMultiplier),
      });
    }
  }
  return data;
}

export const routeTrafficData: RouteTrafficPoint[] = generateRouteTraffic();

// Helper: format số lớn
export function formatNumber(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return num.toString();
}
