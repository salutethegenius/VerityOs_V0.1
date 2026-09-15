import http from "node:http";

const port = Number(process.env.META_MOCK_PORT ?? 8099);
const host = process.env.META_MOCK_HOST ?? "127.0.0.1";

const server = http.createServer((req, res) => {
  const url = req.url ?? "";
  res.setHeader("content-type", "application/json");
  if (url.includes("fields=name")) {
    res.end(JSON.stringify({ name: "Dev Page" }));
    return;
  }
  if (req.method === "POST" && url.includes("/feed")) {
    res.end(JSON.stringify({ id: "111_222" }));
    return;
  }
  res.statusCode = 200;
  res.end(JSON.stringify({ id: "mock" }));
});

server.listen(port, host, () => {
  process.stdout.write(`meta mock listening on ${host}:${port}\n`);
});
