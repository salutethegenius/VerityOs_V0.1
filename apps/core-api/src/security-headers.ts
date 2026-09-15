import type { FastifyReply } from "fastify";

export function applySecurityHeaders(reply: FastifyReply, opts: { https: boolean }): void {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  reply.header("X-Permitted-Cross-Domain-Policies", "none");
  if (opts.https) {
    reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}
