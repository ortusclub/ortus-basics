// job-queue.js — selects the queue implementation.
//
// Default: the in-memory JobQueue (queue.js) — unchanged single-pod behavior.
// USE_REDIS=true: the Redis-backed RedisJobQueue (queue-redis.js) for HPA.
//
// Both expose the same interface, so server.js requires THIS and never cares
// which one it got. `await` works on both (sync returns pass through await).
const USE_REDIS = ["1", "true", "yes"].includes(
  String(process.env.USE_REDIS || "").toLowerCase()
);

if (USE_REDIS) {
  const { RedisJobQueue } = require("./queue-redis");
  const redisUrl =
    process.env.REDIS_URL ||
    (process.env.REDIS_ADDRESS ? `redis://${process.env.REDIS_ADDRESS}` : "redis://127.0.0.1:6379");
  // ROLE=frontend → serve/accept only (never claim jobs); ROLE=worker (or unset)
  // → claim + run jobs. "all" also runs both (single-deployment / local dev).
  const ROLE = String(process.env.ROLE || "all").toLowerCase();
  const isWorker = ROLE !== "frontend";
  console.log(`[engine] queue backend: REDIS (${redisUrl}) role=${ROLE} worker=${isWorker} pod=${process.env.HOSTNAME || "pod"}`);
  module.exports = new RedisJobQueue({
    redisUrl,
    podId: process.env.POD_NAME || process.env.HOSTNAME || "pod",
    podIP: process.env.POD_IP || "", // set via downward API; enables cross-pod View
    podPort: process.env.PORT || "3000",
    isWorker,
  });
} else {
  console.log("[engine] queue backend: in-memory (single pod)");
  module.exports = require("./queue");
}
