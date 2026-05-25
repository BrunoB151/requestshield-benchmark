# Runbook — test de charge RequestShield Edge AI

Cible : 150 000 req/s soutenus sur `POST /api/v1/analyze` derrière l'IPLB public preprod.

Ce runbook décrit la procédure complète : préparation, spawn de la flotte de générateurs, ramp progressif, critères de go/no-go par phase, monitoring, et remise en état.

> Tout le trafic généré est **synthétique**. La distribution par défaut est :
> - **80 % trafic légitime** — sessions navigateur réalistes : même UA + JA3 stable par IP, cookie de session persistant, séquence de navigation (`/` → `/products` → `/cart` → ...) avec referers chaînés.
> - **15 % bruit** — bots déclarés, librairies HTTP (curl, requests, Go-http-client), Postman.
> - **5 % scanner** — UAs sqlmap/nuclei/zgrab/masscan sur `/wp-admin`, `/.env`, `/phpmyadmin`, etc.
>
> **Pool UA** : ~4000 entrées extraites de trafic production réel (navigateurs récents, bots IA modernes — GPTBot, ClaudeBot, PerplexityBot —, WordPress, monitoring, app mobiles, IoT). Voir [scripts/loadtest/payloads/user_agents.txt](../scripts/loadtest/payloads/user_agents.txt).
>
> **Pools IP** :
> - **5 %** burst pool de 500 IPs (configurable `BENCH_BURST_POOL_SIZE`) — exerce `ip_rate`. **Rotation toutes les `BENCH_BURST_ROTATE_MIN` minutes** (défaut 5 min) pour entretenir de la nouveauté.
> - **3 %** rdns_pool — IPs avec PTR connus (Google, Cloudflare, AWS, OVH, Tor) pour `rdns`.
> - **30 %** plages résidentielles réelles (Orange, Free, Deutsche Telekom, Comcast, ...) pour `residential_proxy`.
> - **62 %** diffuse synthétique (~70 % v4 / 30 % v6).
>
> **Signaux divers** : ~2 % de cohérence UA/Sec-CH-UA cassée (`fingerprint_coherence`), ~5 % de rotation JA3 par IP (`ja3_stability`), session affinity sur le trafic bénin (`ua_consistency`).
>
> **Drift de distribution** : option `BENCH_DRIFT_ENABLED=1` — la part scanner ramp de 5 % à 15 % sur la durée du plateau pour exercer la détection de changement. Désactivé par défaut.
>
> Toutes les proportions sont surcouchables via variables d'env (voir tête de [scripts/loadtest/k6_analyze.js](../scripts/loadtest/k6_analyze.js)).

---

## 0. Pré-requis

1. Compte OVH Public Cloud avec quota suffisant : 12 × `b2-15` + 1 × `s1-2` simultanées (≈ 49 vCPU / 183 Go RAM).
2. `openstack application credential` créé sur le projet (voir [README.md](../README.md)).
3. La preprod RequestShield Edge a été scalée conformément à [scaling-checklist.md](scaling-checklist.md).
4. Terraform ≥ 1.5 et `k6` ≥ 0.50 installés localement (pour les tests de fumée hors-VM).
5. Branche `dev/bbontemp/init-benchmark` (ou le nom courant) accessible en clone HTTPS depuis les VMs cloud-init.

---

## 1. Spawn de la flotte

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
# Remplir os_*, ssh_public_key, bench_target_url, bench_host_header
# Si l'endpoint /analyze cible exige X-API-Key, renseigner aussi bench_api_key
# (valeur présente dans RSEDGE_API_KEYS côté API).
terraform init
terraform plan -out plan.bin
terraform apply plan.bin
```

`bench_api_key` est propagée jusqu'à `/etc/rsedge-bench/env` (perms 0600) sur chaque générateur, lue par k6 via `BENCH_API_KEY` et envoyée en header `X-API-Key`. Laisser vide si la cible accepte les requêtes non authentifiées.

À la fin, récupérer les sorties :

```bash
terraform output -raw coordinator_ip
terraform output -json generator_ips
terraform output -raw grafana_url
```

### Enregistrer les générateurs côté Prometheus

```bash
terraform output -json prometheus_targets > /tmp/generators.json
COORD=$(terraform output -raw coordinator_ip)
scp /tmp/generators.json debian@$COORD:/tmp/
ssh debian@$COORD "sudo mv /tmp/generators.json /etc/prometheus/targets/generators.json \
                   && sudo systemctl reload prometheus"
```

Ouvrir Grafana sur `http://$COORD:3000` (admin/admin → changer le mot de passe), ajouter la datasource Prometheus locale (`http://localhost:9090`) et importer un dashboard k6 + node_exporter.

### Sanity check

Sur **un** générateur :

```bash
GEN=$(terraform output -json generator_ips | jq -r '.[0]')
ssh debian@$GEN "k6 version && ls /opt/requestshield-benchmark/scripts/loadtest/"
```

---

## 2. Phasage du tir

À chaque phase, lancer simultanément sur tous les générateurs :

```bash
for ip in $(terraform output -json generator_ips | jq -r '.[]'); do
  ssh -o StrictHostKeyChecking=no debian@$ip "sudo rsedge-bench-run <phase>" &
done
wait
```

Suivre les logs : `ssh debian@$GEN "journalctl -fu k6-run@<phase>"`.

### Critères de progression (go / no-go entre phases)

Une phase est validée si **toutes** les conditions sont remplies pendant au moins 50 % de sa durée plateau :

- `http_req_failed` < 0.5 %
- `http_req_duration` p99 < 300 ms (Grafana → k6 dashboard)
- Lag stream Redis < 5 s : `XLEN requestshield:requests` doit rester < `RPS × 5`
- API : pas de saturation CPU sustained > 85 % sur les instances
- Engine : `engine_batch_duration_seconds` p95 < intervalle de batch (sinon backlog)

Sinon, **arrêter, diagnostiquer, scaler, recommencer la phase**.

### Phase 0 — smoke (2 min, ~100 rps)

```bash
phase=smoke ; ssh debian@$GEN0 "sudo rsedge-bench-run smoke"
```

Vérifier sur la VM API la diversité des décisions dans `journalctl -u api.service | grep decision_returned`. On doit voir un mix `allow` / `challenge` / `block`. Si tout est `allow`, les seuils ML sont peut-être trop tolérants pour le trafic synthétique — ajuster avant de continuer.

### Phase 1 — baseline (5 min, 1 k rps total)

- `BENCH_RPS_SHARE` effective ≈ 1000/12 ≈ 83 rps par générateur.
- Mesurer la latence p50/p99 de référence.

Réduire le RPS share via env override (pas besoin de modifier le service) :

```bash
ssh debian@$GEN "sudo sed -i 's/^BENCH_RPS_SHARE=.*/BENCH_RPS_SHARE=83/' /etc/rsedge-bench/env && sudo rsedge-bench-run baseline"
```

### Phase 2 — warm (10 min, 10 k rps)

Share 10000/12 ≈ 833 rps par générateur. Vérifier le premier signal Engine (compteurs `engine_events_consumed_total`).

### Phase 3 — mid (10 min, 50 k rps)

Share 50000/12 ≈ 4167. Premier vrai test de scaling API + PG writes côté Engine.

### Phase 4 — high (15 min, 100 k rps)

Share 100000/12 ≈ 8333. Surveiller la backpressure Redis (`XLEN`, `XADD` rate côté API).

### Phase 5 — target_150k (30 min, 150 k rps) — **L'OBJECTIF**

Share 12500 par générateur. Garder cette phase plein régime pendant 30 min minimum pour observer :

- Stabilité latence p99 dans le temps (drift ?)
- Croissance disk PG (writes Engine)
- Évolution distribution des décisions à mesure que les modèles « apprennent » les IPs du burst pool
- Saturation IPLB ? (compteurs OVH côté IPLB, ou perte de paquets `tcp_retransmit` sur les VMs)

### Phase 6 — spike (1 min, 200 k rps)

Test de headroom et de comportement sous saturation. **Ne pas** valider de critère ici — on accepte la dégradation, on observe le retour à l'équilibre après.

### Phase 7 — soak (optionnel, 2 h, 100 k rps)

Détection de fuites mémoire / drift PG / partition rotation, etc.

---

## 3. Pendant le run — où regarder

- **Grafana coordinator** (`:3000`) — k6 vitals + node CPU/network par générateur.
- **API metrics** — `curl https://<api>/metrics | grep -E "requests_total|request_duration|queue_publish_total"` ou via Prometheus stack preprod.
- **Redis stream** — `redis-cli XLEN requestshield:requests` (sur un bastion preprod).
- **Engine** — logs structurés `engine_batch_processed` + métriques.
- **PostgreSQL** — `pg_stat_activity`, IOPS via Managed PG console OVH.
- **IPLB** — métriques OVH (Manager → IPLB → graphs) : pps, taux d'erreur 5xx.

---

## 4. Arrêt et nettoyage

Arrêt propre d'une phase :

```bash
for ip in $(terraform output -json generator_ips | jq -r '.[]'); do
  ssh debian@$ip "sudo systemctl stop 'k6-run@*'" &
done
wait
```

Destruction de la flotte :

```bash
terraform destroy
```

Remise en état preprod : voir [scaling-checklist.md](scaling-checklist.md) section « Rollback ».

---

## 5. Points d'attention connus

- **Enrichissement GeoIP synchrone** ([api/main.py:751](../../ai-requestshield-edge/api/main.py)) — appel `run_in_executor(None, …)` sur le default thread pool. À 150 k rps c'est un suspect prioritaire si la latence p99 explose alors que le CPU des workers uvicorn n'est pas saturé.
- **Cardinalité IPs** — le pool diffuse génère des dizaines de millions d'IPs distinctes. La table `scores` partitionnée peut grossir vite ; surveiller la taille disque PG.
- **Whitelist OVH** — si le projet preprod a une whitelist IP/ASN d'OVH côté IPLB ou côté API (`RSEDGE_ALLOWED_IPS`), s'assurer que les IPs publiques des générateurs sont autorisées avant le tir.
- **Couts** — 12 × b2-15 + 1 × s1-2 pendant 4 h ≈ X € (à confirmer sur la grille OVH actuelle). Ne laisser tourner que pendant la fenêtre prévue.

---

## 6. Reproductibilité

La même campagne peut être rejouée à l'identique avec `bench_seed` constant : le générateur de payload est déterministe (xorshift32 seedée par VM index), les pools sont en clair dans le repo, et la liste des phases est documentée ci-dessus. Le seul drift attendu vient de l'état de la preprod (scores PG cumulés des runs précédents — vider la base avant un run « propre »).
