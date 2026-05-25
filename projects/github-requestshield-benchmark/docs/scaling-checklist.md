# Scaling de la preprod avant tir 150 k rps

Checklist à dérouler sur la stack preprod **avant** de lancer le ramp, puis à rollback en fin de campagne.

Les valeurs cibles sont indicatives — à ajuster en fonction des résultats des phases warm / mid.

## 1. API RequestShield Edge

- **Replicas API** : ≥ 8 instances. Si la preprod tourne sur compose, scaler le service API ; sur Nomad/k8s, augmenter `count`/`replicas`.
- **Uvicorn workers** : ≥ vCPU par instance. Variable d'env de l'image API (`UVICORN_WORKERS` ou flag de la commande).
- **Keep-alive** : confirmer que l'IPLB est en mode `tcp` (ou `http` avec keep-alive activé) — un `Connection: close` à chaque hit tue le débit à ce niveau.
- **`RSEDGE_ALLOWED_IPS`** : ajouter les /32 publics des générateurs si l'API filtre par IP (par défaut `/analyze` ne filtre pas, mais vérifier la config preprod).
- **`/metrics`** : exposé et scrapé par le Prometheus preprod, pour corrélation avec les métriques du coordinator de bench.

## 2. Redis / Valkey (stream `requestshield:requests`)

- **Plan Managed Valkey** : vérifier la capacité `XADD/s` annoncée par OVH. À 150 k rps c'est 150 k XADD/s. Si le plan actuel est en dessous, **upgrader avant** le tir.
- **Maxlen du stream** : actuellement `100_000` ([api/queue.py:46](../../ai-requestshield-edge/api/queue.py)). À 150 k rps c'est moins d'1 s de rétention. Pas un problème en soi (le stream est un buffer, pas un journal), mais l'Engine doit consommer plus vite que ça produit — sinon perte de messages.
- **Mémoire** : surveiller `used_memory` ; si l'Engine retarde de plusieurs secondes le stream peut dépasser maxlen.

## 3. Engine RequestShield Edge

- **Long-running mode** : `engine-worker.service`, **pas** `engine-batch.timer` pendant un test de charge.
- **Replicas Engine** : ≥ 4 instances (consumer group Redis, partage automatique).
- **`RSEDGE_ENGINE_BATCH_SIZE`** : augmenter (par exemple 500 → 2000) si le throughput de consommation Redis est limitant.
- **Connexions PG** : `RSEDGE_DATABASE_POOL_SIZE` × `replicas` doit rester sous le `max_connections` du Managed PG. À 4 replicas × 50 conns = 200, OVH Standard PG = 200 par défaut → marge nulle, prévoir un plan PG plus généreux.

## 4. PostgreSQL Managed

- **Plan** : vérifier IOPS et `shared_buffers`. Une heure à 150 k rps avec ~10 % de scores écrits = ~50 M lignes upsert en 1 h → surveiller IOPS write.
- **Partitions** : la table `scores` est LIST-partitionnée par `score_type` ([docs/Architecture/](../../ai-requestshield-edge/docs/Architecture/)). S'assurer que toutes les partitions courantes existent avant le tir.
- **`autovacuum_naptime`** : abaisser (par ex. 10 s) pour éviter le bloat pendant le run.
- **Connexions** : prévoir `max_connections` ≥ replicas API × pool + replicas Engine × pool + monitoring + slack.

## 5. IPLB

- **Bande passante** : un POST `/analyze` ≈ 1 KB request + 200 B response → 1.2 KB × 150 k = 180 MB/s soit ~1.5 Gbit/s. Vérifier que le plan IPLB et son uplink portent ce débit.
- **Backend pool** : tous les API replicas enregistrés, en santé.
- **Sticky session** : désactivée (les générateurs ne maintiennent pas de session côté LB).

## 6. Observabilité

- **Prometheus preprod** : confirmer qu'il scrape API + Engine + Redis exporter + PG exporter.
- **Loki preprod** : prêt à absorber les logs `decision_returned` (1 ligne par requête → 150 k lignes/s, ~150 GB de logs structurés sur 1 h). Si Loki est sous-dimensionné, **réduire temporairement le niveau de log** côté API (`RSEDGE_LOG_LEVEL=WARNING`) pour le run, ou désactiver `_emit_decision_log` au plus chaud.
- **Grafana preprod** : dashboards API + Engine + Redis stream lag accessibles.

## 7. Rollback (en fin de campagne)

1. `terraform destroy` sur ce repo → suppression de la flotte de bench.
2. Re-scale API / Engine à leur valeur preprod nominale.
3. Re-scale Managed Valkey / Managed PG si upgrade temporaire.
4. Si la base scores a été vidée pour la propreté, restaurer un snapshot ou laisser l'Engine reconstruire.
5. Mettre à jour [docs/training/](../../ai-requestshield-edge/docs/training/) avec les enseignements du run (drift de seuils, paramètres ML à recalibrer).

## 8. Critères go pour démarrer le tir

| Item | OK ? |
|---|---|
| Quota OpenStack vérifié | ☐ |
| API ≥ 8 replicas, `/metrics` OK | ☐ |
| Engine ≥ 4 replicas long-running | ☐ |
| Valkey plan upgrade confirmé | ☐ |
| PG plan + max_connections OK | ☐ |
| IPLB capacité confirmée | ☐ |
| Prometheus + Grafana opérationnels (preprod + coordinator) | ☐ |
| `RSEDGE_LOG_LEVEL` configuré pour absorber le débit | ☐ |
| IPs publiques des générateurs whitelistées si besoin | ☐ |
| Fenêtre de tir annoncée à l'équipe (Slack #rsedge-mco) | ☐ |
| Snapshot PG pris (rollback rapide en cas d'incident) | ☐ |
