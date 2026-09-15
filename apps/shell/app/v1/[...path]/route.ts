import { NextRequest } from "next/server";

const CORE = process.env.CORE_API_URL ?? "http://127.0.0.1:8080";

async function proxy(request: NextRequest, path: string[]): Promise<Response> {
  const target = `${CORE}/v1/${path.join("/")}${request.nextUrl.search}`;
  const headers = new Headers();
  const cookie = request.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  const origin = request.headers.get("origin") ?? process.env.CORS_ORIGIN ?? "http://127.0.0.1:3000";
  headers.set("origin", origin);
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const requestId = request.headers.get("x-request-id");
  if (requestId) headers.set("x-request-id", requestId);

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }

  const upstream = await fetch(target, init);
  const out = new Headers();
  const contentTypeOut = upstream.headers.get("content-type");
  if (contentTypeOut) out.set("content-type", contentTypeOut);
  const rid = upstream.headers.get("x-request-id");
  if (rid) out.set("x-request-id", rid);
  const setCookies =
    typeof upstream.headers.getSetCookie === "function" ? upstream.headers.getSetCookie() : [];
  for (const cookieValue of setCookies) {
    out.append("set-cookie", cookieValue);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(request: NextRequest, context: Ctx) {
  return proxy(request, (await context.params).path);
}
export async function POST(request: NextRequest, context: Ctx) {
  return proxy(request, (await context.params).path);
}
export async function PUT(request: NextRequest, context: Ctx) {
  return proxy(request, (await context.params).path);
}
export async function PATCH(request: NextRequest, context: Ctx) {
  return proxy(request, (await context.params).path);
}
export async function DELETE(request: NextRequest, context: Ctx) {
  return proxy(request, (await context.params).path);
}
