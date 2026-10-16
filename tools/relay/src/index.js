import { flushPending } from "./cron.js";
import { handleRequest } from "./handler.js";

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
  // Hourly Cron Trigger. A thrown error shows up in the Worker's logs and the items stay pending for the next run.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      flushPending(env).then(
        (r) => console.log(`flushed ${r.committed} contributions`, r.commit || ""),
        (err) => {
          console.error("flush failed:", err.message);
          throw err;
        },
      ),
    );
  },
};
