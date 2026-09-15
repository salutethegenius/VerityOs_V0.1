const CORE = process.env.CORE_API_URL ?? "http://127.0.0.1:8080";

export async function GET() {
  try {
    const response = await fetch(`${CORE}/health/ready`, { cache: "no-store" });
    if (!response.ok) {
      return Response.json({ status: "degraded", component: "shell", core: "not_ready" }, { status: 503 });
    }
    return Response.json({ status: "ok", component: "shell", phase: "11", core: "ready" });
  } catch {
    return Response.json({ status: "degraded", component: "shell", core: "unreachable" }, { status: 503 });
  }
}
