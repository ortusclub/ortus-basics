// pod-deletion-cost.js
//
// Protects BUSY worker pods from scale-down. While a worker is running scrapes,
// it stamps the Kubernetes `controller.kubernetes.io/pod-deletion-cost`
// annotation on its OWN Pod with a positive value (= number of in-flight
// scrapes). When the ReplicaSet scales down (KEDA N→0), Kubernetes deletes the
// LOWEST-cost pods first — so idle pods (cost 0) go before busy ones, and a long
// scrape is never cut mid-run by a routine scale-down.
//
// Best-effort and self-contained:
//   • No-op outside the cluster (no service-account token present) so local dev
//     and tests are completely unaffected.
//   • Any API error is swallowed — the worst case is the pre-existing behaviour
//     (a busy pod might still be picked, which the long terminationGracePeriod
//     then tries to drain). It can never break a scrape.
//   • Dedupes — only PATCHes the API server when the cost actually changes.
//
// Requires (in-cluster, set by k8s/10-worker-deployment.yaml + RBAC):
//   • POD_NAME / POD_NAMESPACE  (downward API)
//   • a ServiceAccount allowed to `patch` its own pod (k8s/11-worker-rbac.yaml)

const fs = require("fs");
const https = require("https");

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
const TOKEN_PATH = `${SA_DIR}/token`;
const CA_PATH = `${SA_DIR}/ca.crt`;
const ANNOTATION = "controller.kubernetes.io/pod-deletion-cost";

let _capable = null;  // memoized capability check
let _lastCost = null; // dedupe — only PATCH when the value changes

function capable() {
  if (_capable !== null) return _capable;
  _capable =
    !!process.env.POD_NAME &&
    !!process.env.POD_NAMESPACE &&
    !!process.env.KUBERNETES_SERVICE_HOST &&
    fs.existsSync(TOKEN_PATH);
  return _capable;
}

// Set this pod's deletion cost. `cost` is an integer; HIGHER = deleted LATER.
// Returns a promise resolving true on success, false otherwise — never rejects.
function setPodDeletionCost(cost) {
  return new Promise((resolve) => {
    try {
      const value = String(Math.trunc(Number(cost)) || 0);
      if (!capable() || value === _lastCost) return resolve(false);

      const token = fs.readFileSync(TOKEN_PATH, "utf8").trim();
      const ca = fs.existsSync(CA_PATH) ? fs.readFileSync(CA_PATH) : undefined;
      const ns = process.env.POD_NAMESPACE;
      const name = process.env.POD_NAME;
      const body = JSON.stringify({ metadata: { annotations: { [ANNOTATION]: value } } });

      const req = https.request(
        {
          host: process.env.KUBERNETES_SERVICE_HOST,
          port: process.env.KUBERNETES_SERVICE_PORT_HTTPS || process.env.KUBERNETES_SERVICE_PORT || 443,
          method: "PATCH",
          path: `/api/v1/namespaces/${ns}/pods/${name}`,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/merge-patch+json",
            "Content-Length": Buffer.byteLength(body),
          },
          ca,
          rejectUnauthorized: !!ca, // verify against the in-cluster CA when present
          timeout: 5000,
        },
        (res) => {
          res.resume(); // drain the response
          const ok = res.statusCode >= 200 && res.statusCode < 300;
          if (ok) _lastCost = value;
          resolve(ok);
        }
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
      req.write(body);
      req.end();
    } catch (_) {
      resolve(false);
    }
  });
}

module.exports = { setPodDeletionCost };
