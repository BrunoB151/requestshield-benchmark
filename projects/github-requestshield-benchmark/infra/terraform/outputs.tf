output "coordinator_ip" {
  description = "Public IP of the coordinator (Prometheus + Grafana on :3000)."
  value       = openstack_compute_instance_v2.coordinator.access_ip_v4
}

output "generator_ips" {
  description = "Public IPs of the k6 generators (SSH then `journalctl -u k6` to follow runs)."
  value       = openstack_compute_instance_v2.generator[*].access_ip_v4
}

output "rps_per_generator" {
  description = "Target RPS each generator emits at plateau."
  value       = local.rps_per_generator
}

output "total_target_rps" {
  description = "Theoretical aggregate RPS once all generators reach plateau."
  value       = local.rps_per_generator * var.generator_count
}

output "grafana_url" {
  description = "Grafana on the coordinator. Default creds: admin / admin (change after first login)."
  value       = "http://${openstack_compute_instance_v2.coordinator.access_ip_v4}:3000"
}

# Run after `terraform apply`:
#   terraform output -json prometheus_targets > generators.json
#   scp generators.json debian@<coordinator_ip>:/tmp/
#   ssh debian@<coordinator_ip> "sudo mv /tmp/generators.json /etc/prometheus/targets/generators.json && sudo systemctl reload prometheus"
output "prometheus_targets" {
  description = "Drop-in file_sd_configs payload to scrape generator node_exporters."
  value = [{
    targets = openstack_compute_instance_v2.generator[*].access_ip_v4
    labels  = { role = "generator" }
  }]
}

