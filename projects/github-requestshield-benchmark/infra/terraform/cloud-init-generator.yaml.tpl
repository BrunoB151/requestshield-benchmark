#cloud-config
# Generator node: installs k6, pulls the benchmark repo, exposes /metrics via
# k6's prometheus remote-write endpoint to the coordinator. No phase is started
# automatically — the runbook drives `k6 run` over SSH so each phase ramp is
# explicitly coordinated.

package_update: true
package_upgrade: false

packages:
  - ca-certificates
  - gnupg2
  - curl
  - git

write_files:
  - path: /etc/rsedge-bench/env
    permissions: "0644"
    content: |
      BENCH_TARGET=${bench_target_url}
      BENCH_HOST=${bench_host_header}
      BENCH_RPS_SHARE=${bench_rps_share}
      BENCH_SEED=${bench_seed}
      BENCH_PHASE=smoke
      K6_PROMETHEUS_RW_SERVER_URL=http://${coordinator_ip}:9090/api/v1/write
      K6_PROMETHEUS_RW_TREND_STATS=p(50),p(95),p(99),max
      K6_PROMETHEUS_RW_PUSH_INTERVAL=5s
      GENERATOR_INDEX=${generator_index}

  - path: /etc/systemd/system/k6-run@.service
    permissions: "0644"
    content: |
      [Unit]
      Description=k6 load test phase %i
      After=network-online.target
      Wants=network-online.target

      [Service]
      Type=simple
      WorkingDirectory=/opt/requestshield-benchmark/scripts/loadtest
      EnvironmentFile=/etc/rsedge-bench/env
      Environment=BENCH_PHASE=%i
      Environment=K6_OUT=experimental-prometheus-rw
      ExecStart=/usr/bin/k6 run k6_analyze.js
      Restart=no
      StandardOutput=journal
      StandardError=journal

  - path: /usr/local/bin/rsedge-bench-run
    permissions: "0755"
    content: |
      #!/bin/sh
      # Helper: rsedge-bench-run <phase>
      set -eu
      phase="$${1:-smoke}"
      systemctl reset-failed "k6-run@$${phase}" 2>/dev/null || true
      exec systemctl start "k6-run@$${phase}"

runcmd:
  # 1. Official k6 apt repo
  - curl -fsSL https://dl.k6.io/key.gpg | gpg --dearmor -o /usr/share/keyrings/k6-archive-keyring.gpg
  - echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" > /etc/apt/sources.list.d/k6.list
  - apt-get update
  - apt-get install -y k6

  # 2. Clone the benchmark repo. Public over HTTPS — anonymous Bitbucket clone.
  #    If the repo is private, the user must pre-bake a deploy token or seed
  #    /root/.netrc via additional write_files (kept out of this template).
  - git clone --depth=1 --branch ${benchmark_repo_ref} ${benchmark_repo} /opt/requestshield-benchmark || true

  # 3. Reload systemd so k6-run@.service is registered.
  - systemctl daemon-reload

  # 4. Node-exporter for host metrics (CPU/net visibility from the coordinator).
  - apt-get install -y prometheus-node-exporter
  - systemctl enable --now prometheus-node-exporter

final_message: "rsedge-bench generator ${generator_index} ready. Drive runs with: rsedge-bench-run <phase>"
