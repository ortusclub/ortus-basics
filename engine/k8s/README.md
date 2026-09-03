# Kubernetes deployment guide

This directory contains everything you need to run the Sales Nav scraper on
a Kubernetes cluster with **real autoscaling**.

## What you get

| Layer | What scales it |
|-------|----------------|
| Pod CPU / RAM | **VPA** (Vertical Pod Autoscaler) — grows the pod when load rises |
| Pod count | HPA is provided but disabled — see notes |
| Persistent LinkedIn sessions | PVC mounted at `/app/sessions` |
| HTTPS + noVNC popup | Ingress with WebSocket support |

## What you need before deploying

1. **A Kubernetes cluster** with metrics-server installed.
   Recommended: **GKE Autopilot** (VPA is on by default, easiest setup).
   Also works on EKS / AKS / DOKS / self-hosted, but you'll need to
   install the VPA addon yourself (link inside `06-vpa.yaml`).

2. **`kubectl`** configured for that cluster:
   ```
   kubectl cluster-info
   ```

3. **A container registry** to push the built image to (GCR, ECR, Docker Hub, etc).

4. **A domain name** pointing at your cluster's ingress IP. You'll fill this
   into `05-ingress.yaml`.

5. **Your `service-account.json`** (Google Sheets) and a strong app password.

## Quick deploy (10 steps)

```bash
# 0. From the project root (where Dockerfile lives)

# 1. Build the image
docker build -t YOUR_REGISTRY/salesnav-scraper:v1 .

# 2. Push it
docker push YOUR_REGISTRY/salesnav-scraper:v1

# 3. Create the namespace
kubectl apply -f k8s/00-namespace.yaml

# 4. Create the persistent volume for sessions
kubectl apply -f k8s/01-pvc.yaml

# 5. Create the secrets (from your local files)
kubectl -n salesnav-scraper create secret generic salesnav-secrets \
  --from-file=GOOGLE_SERVICE_ACCOUNT_JSON=./service-account.json \
  --from-literal=APP_PASSWORD='your-strong-password-here'

# 6. Edit 03-deployment.yaml — replace REPLACE_ME with YOUR_REGISTRY/salesnav-scraper:v1
# 7. Edit 05-ingress.yaml  — replace REPLACE_ME.example.com with your real domain

# 8. Apply the rest
kubectl apply -f k8s/03-deployment.yaml
kubectl apply -f k8s/04-service.yaml
kubectl apply -f k8s/05-ingress.yaml
kubectl apply -f k8s/06-vpa.yaml

# 9. Watch it come up
kubectl -n salesnav-scraper get pods -w

# 10. Once running, browse to https://your-domain/
```

## Day-2 ops

### Watch what VPA recommends

```bash
kubectl -n salesnav-scraper describe vpa salesnav-scraper
```

Look at the "Recommendation" block. If those numbers look sane to you,
flip VPA from observation mode to active mode:

Edit `06-vpa.yaml`:
```yaml
spec:
  updatePolicy:
    updateMode: "Auto"   # was "Off"
```

Re-apply: `kubectl apply -f k8s/06-vpa.yaml`.

From this point, K8s will **automatically resize the pod** when load
changes. Each resize restarts the pod (state is preserved via the PVC, but
any in-flight scrape jobs at that moment will fail and need to be restarted
by the user). For most cases this is acceptable.

### Tail the app logs

```bash
kubectl -n salesnav-scraper logs deployment/salesnav-scraper -f
```

### Shell into the running pod

```bash
kubectl -n salesnav-scraper exec -it deployment/salesnav-scraper -- bash
```

### Rollout a new app version

```bash
docker build -t YOUR_REGISTRY/salesnav-scraper:v2 .
docker push    YOUR_REGISTRY/salesnav-scraper:v2
kubectl -n salesnav-scraper set image deployment/salesnav-scraper app=YOUR_REGISTRY/salesnav-scraper:v2
```

### Scale up / down manually

If you want to override VPA temporarily:

```bash
kubectl -n salesnav-scraper set resources deployment/salesnav-scraper \
  --requests=cpu=2,memory=4Gi --limits=cpu=8,memory=16Gi
```

## Expected monthly cost

For GKE Autopilot in a cheap region:

| What | Cost |
|------|------|
| Pod usage (varies with VPA) | ~$30–150 |
| PVC (5 GiB pd-balanced) | ~$1 |
| Cluster control plane (Autopilot) | ~$73 (24/7) |
| Egress + ingress LB | ~$20–40 |
| **Total** | **~$125–260/mo** |

EKS and AKS are in a similar range. Self-hosted on a 3-node cluster of
mid-tier VMs runs ~$60–150/mo depending on provider.

## Why VPA, not HPA?

Each LinkedIn session is stored as a Chromium profile on the local PVC.
Two pods can't share that volume in ReadWriteOnce mode (which is what most
cloud providers default to), and users would lose their session every time
their request landed on a different pod.

To make horizontal scaling (HPA) useful you need:
1. Move session storage to shared/remote (Redis, S3, Firestore).
2. Use a `ReadWriteMany` PVC OR no PVC.
3. Add sticky routing on the Ingress by userId cookie.

That's roughly a week of additional engineering work. Until then VPA
gives you the "scales up under load" story with a single replica, which
is what the team actually needs at 15–50 users.

## KEDA customizations (cluster-only — NOT in these manifests)

KEDA is installed from its upstream manifest (not Helm). Two idle-cost tweaks were
applied **directly to the cluster** and are **not** captured in this repo, so a KEDA
reinstall/upgrade (re-applying the upstream YAML) will silently revert them — re-apply
after any KEDA upgrade:

1. **Admission webhook removed** (saves one always-on pod). Deleted:
   `deploy/keda-admission` + `svc/keda-admission-webhooks` (namespace `keda`) and the
   cluster-scoped `validatingwebhookconfiguration/keda-admission`. All webhooks were
   `failurePolicy: Ignore` (fail-open), so removal cannot block ScaledObject changes;
   the trade-off is no server-side validation of ScaledObject/TriggerAuthentication
   specs at apply time. **Delete the ValidatingWebhookConfiguration too** — deleting
   only the Deployment would leave the API server calling a dead endpoint.
2. **Cert rotation disabled** on `deploy/keda-operator`: arg `--enable-cert-rotation=false`
   (was `true`). Without it the operator logs a recurring `ERROR "Webhook not found"`
   trying to rotate the deleted webhook's cert. Only valid while the webhook is removed.

To re-apply both after a KEDA upgrade:
```
kubectl delete validatingwebhookconfiguration keda-admission
kubectl delete deploy keda-admission -n keda
kubectl delete svc keda-admission-webhooks -n keda
kubectl patch deploy keda-operator -n keda --type=json \
  -p='[{"op":"replace","path":"/spec/template/spec/containers/0/args/4","value":"--enable-cert-rotation=false"}]'
```
The campaign ScaledObject scales on the Redis list `cmp:scaleactive` (see
`22-campaign-keda.yaml`), which the always-on frontend refreshes from Postgres — KEDA
needs no database access of its own.

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|-------------------|
| Pod stuck `Pending` | PVC can't be provisioned. Check StorageClass. `kubectl -n salesnav-scraper describe pvc salesnav-sessions` |
| campaign-worker won't scale up | Check the metric is served: `kubectl get --raw "/apis/external.metrics.k8s.io/v1beta1/namespaces/salesnav-scraper/s0-redis-cmp-scaleactive?labelSelector=scaledobject.keda.sh%2Fname%3Dcampaign-worker"`. If the frontend's `[scale-bridge]` log is silent, the DB→Redis bridge (server.js) isn't running. |
| Pod `CrashLoopBackOff` | Read logs: `kubectl -n salesnav-scraper logs deployment/salesnav-scraper`. Most common: missing secret or bad service account JSON. |
| Chromium crashes on launch | `/dev/shm` too small. Bump `sizeLimit` in `03-deployment.yaml` `dshm` volume. |
| noVNC popup shows blank | Ingress timeout too short. Confirm `proxy-read-timeout: "3600"` is set. |
| VPA never recommends anything | Metrics server not installed. `kubectl top pods -n salesnav-scraper` should work — if it doesn't, install metrics-server. |
| Session files lost after restart | PVC not mounted. Check the deployment's `volumeMounts`. |
