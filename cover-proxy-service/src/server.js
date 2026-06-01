import { createApp } from "./index.js";

const PORT = parseInt(process.env.PORT, 10) || 3010;

const app = createApp();
app.listen(PORT, "127.0.0.1", () => {
  console.log(`[cover-proxy] listening on http://127.0.0.1:${PORT}`);
});
