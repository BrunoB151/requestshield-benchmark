#cloud-config
# Coordinator: Prometheus (ingests k6 + node_exporter from every generator)
# + Grafana for live dashboards. No k6 binary here.

package_update: true
package_upgrade: false

packages:
  - ca-certificates
  - curl
  - gnupg2
  - prometheus
  - prometheus-node-exporter

write_files:
  - path: /etc/prometheus/prometheus.yml
    permissions: "0644"
    content: |
      global:
        scrape_interval: 10s
        evaluation_interval: 10s

      # k6 generators push via remote_write; we accept it on /api/v1/write.
      # Generators are discovered through file_sd: terraform writes their IPs
      # into /etc/prometheus/targets/generators.json after apply.
      scrape_configs:
        - job_name: node
          file_sd_configs:
            - files: ["/etc/prometheus/targets/generators.json"]
          relabel_configs:
            - source_labels: [__address__]
              regex: "(.*)"
              target_label: __address__
              replacement: "$${1}:9100"
        - job_name: prometheus
          static_configs:
            - targets: ["localhost:9090"]

  - path: /etc/default/prometheus
    permissions: "0644"
    content: |
      ARGS="--web.enable-remote-write-receiver --storage.tsdb.retention.time=15d"

  - path: /etc/prometheus/targets/generators.json
    permissions: "0644"
    content: |
      [
        { "targets": [], "labels": { "role": "generator" } }
      ]

runcmd:
  # Grafana official apt repo
  - curl -fsSL https://apt.grafana.com/gpg.key | gpg --dearmor -o /usr/share/keyrings/grafana-archive-keyring.gpg
  - echo "deb [signed-by=/usr/share/keyrings/grafana-archive-keyring.gpg] https://apt.grafana.com stable main" > /etc/apt/sources.list.d/grafana.list
  - apt-get update
  - apt-get install -y grafana

  - systemctl restart prometheus
  - systemctl enable --now prometheus-node-exporter
  - systemctl enable --now grafana-server

final_message: "rsedge-bench coordinator ready. Grafana: http://<this_ip>:3000 (admin/admin). Expected generators: ${generator_count}."
