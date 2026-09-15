import { assertStartupConfig } from "./runtime-config.js";
import { buildServer } from "./server.js";

assertStartupConfig();
const { app } = await buildServer();
const port = Number(process.env.PORT ?? 8080);
await app.listen({ host: "0.0.0.0", port });
