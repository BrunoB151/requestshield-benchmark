# requestshield-benchmark

Outillage de **test de charge** pour [RequestShield Edge AI](https://stash.ovh.net/scm/~bruno.bontemps/ai-requestshield-edge.git).

Objectif : générer jusqu'à **150 000 req/s** sur `POST /api/v1/analyze` depuis OVH Public Cloud,
avec des payloads synthétiques riches pour exercer l'analyse ET l'apprentissage des modèles ML
(IP rate, URI scan, fingerprint coherence, JA3 stability, UA consistency, etc.).

## Structure

```
.
├── scripts/loadtest/
│   ├── k6_analyze.js              # script k6 principal (scénarios paramétrés)
│   ├── lib/
│   │   ├── ip_gen.js              # générateur IPv4 + IPv6 déterministe (seed)
│   │   └── payload_gen.js         # construction du body /analyze
│   └── payloads/
│       ├── user_agents.txt        # ~4000 UAs production (navigateurs, bots IA, WordPress, IoT, ...)
│       ├── ja3.txt                # ~20 empreintes JA3 réalistes
│       ├── uris_benign.txt        # ~60 URIs légitimes
│       ├── uris_scanner.txt       # ~40 URIs typiques scanner
│       ├── residential_ranges.txt # CIDRs ISP résidentiels (Orange, Free, Comcast, ...) → residential_proxy
│       └── rdns_pool.txt          # IPs à PTR connu (Google, Cloudflare, AWS, OVH, ...) → rdns
├── infra/terraform/
│   ├── main.tf                    # spawn N generators + 1 coordinator (OpenStack/OVH)
│   ├── variables.tf
│   ├── outputs.tf
│   ├── terraform.tfvars.example
│   ├── cloud-init-generator.yaml.tpl
│   └── cloud-init-coordinator.yaml.tpl
└── docs/
    ├── runbook.md                 # procédure pas-à-pas (FR)
    └── scaling-checklist.md       # tuning preprod avant tir
```

## Cible et méthode (résumé)

- **Cible** : IPLB public de la stack preprod RequestShield Edge.
- **Topologie** : 12 × `b2-15` (4 vCPU / 15 Go) en générateurs, 1 × `s1-2` coordinator,
  tous dans la même région OVH + même vRack que l'API.
- **Outil** : [k6](https://k6.io/) — exécuteur `ramping-arrival-rate`, sortie Prometheus
  remote-write vers le coordinator.
- **Payloads** : 100 % synthétiques, déterministes (seed par VM), distribution
  80 % bénin / 15 % bruyant / 5 % scanner. UAs extraits de trafic production
  (~4000 entrées). IPs : 5 % burst rotaté, 3 % rDNS pool, 30 % plages
  résidentielles réelles, 62 % diffuse v4/v6.
- **Ramp** : smoke → 1 k → 10 k → 50 k → 100 k → **150 k** → spike 200 k. Critères
  go/no-go par phase dans [docs/runbook.md](docs/runbook.md).
- **Couverture modèles** : `ip_rate`, `ip_uri_scan`, `bot_signature`,
  `ua_consistency`, `fingerprint_coherence`, `ja3_stability`, `signal_correlation`,
  `residential_proxy`, `rdns` exercés ; `ip_fingerprint_iforest` partiellement.
- **Drift optionnel** (`BENCH_DRIFT_ENABLED=1`) : la part scanner ramp 5 %→15 %
  sur la durée du plateau pour exercer la détection de changement.

## Démarrage rapide

1. Scaler la preprod selon [docs/scaling-checklist.md](docs/scaling-checklist.md).
2. `cd infra/terraform && cp terraform.tfvars.example terraform.tfvars` puis remplir.
3. `terraform init && terraform apply` — sortie : IPs des generators + URL Grafana coordinator.
4. Suivre [docs/runbook.md](docs/runbook.md) phase par phase.
5. `terraform destroy` en fin de campagne.

## Hypothèses

- L'API `/analyze` est ouverte (pas de `X-API-Key` requis sur cette route).
- Le client cible est `https://<api>.<instance>-preprod.requestshield.ovh/api/v1/analyze`.
- Réseau privé vRack disponible entre generators et IPLB / instances API.
- Quota project public cloud suffisant pour 13 instances `b2-15`/`s1-2` simultanées.
