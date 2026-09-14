import { buildServer } from "./server.js";

const { app } = await buildServer();
const port = Number(process.env.PORT ?? 8080);
await app.listen({ host: "0.0.0.0", port });
