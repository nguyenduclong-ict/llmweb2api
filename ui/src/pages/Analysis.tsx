import { KPICards } from "../components/charts/KPICards";
import RequestVolumeChart from "../components/charts/RequestVolumeChart";
import StatusCodePieChart from "../components/charts/StatusCodePieChart";
import EndpointLatencyChart from "../components/charts/EndpointLatencyChart";
import RouteTrafficChart from "../components/charts/RouteTrafficChart";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

export default function Analysis() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Analysis</h1>
        <p className="text-muted-foreground">
          API performance, traffic, and system health overview
        </p>
      </div>

      {/* KPI Cards Row */}
      <KPICards />

      {/* Row 1: Line Chart + Pie Chart */}
      <div className="grid gap-6 lg:grid-cols-7">
        <Card className="lg:col-span-4">
          <CardHeader>
            <CardTitle>Request Volume Over Time</CardTitle>
          </CardHeader>
          <CardContent>
            <RequestVolumeChart />
          </CardContent>
        </Card>
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Status Code Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            <StatusCodePieChart />
          </CardContent>
        </Card>
      </div>

      {/* Row 2: Bar Chart Full Width */}
      <Card>
        <CardHeader>
          <CardTitle>Response Time by Endpoint (ms)</CardTitle>
        </CardHeader>
        <CardContent>
          <EndpointLatencyChart />
        </CardContent>
      </Card>

      {/* Row 3: Stacked Area Chart Full Width */}
      <Card>
        <CardHeader>
          <CardTitle>Traffic by Route Group</CardTitle>
        </CardHeader>
        <CardContent>
          <RouteTrafficChart />
        </CardContent>
      </Card>
    </div>
  );
}
