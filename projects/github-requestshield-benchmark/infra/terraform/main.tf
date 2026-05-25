# -------------------------------------------------------------------------
# Load-test fleet for RequestShield Edge AI
#
# Spawns:
#   - 1 coordinator (s1-2) running Prometheus + Grafana, scrapes generators
#   - N generators  (b2-15) running k6, push metrics to coordinator
#
# All instances get a public IP. Generators talk to the IPLB over public IPv4
# (the IPLB is the chosen test surface). Adjust to vRack-only if you swap
# `bench_target_url` to a private endpoint.
# -------------------------------------------------------------------------

data "openstack_compute_flavor_v2" "generator" {
  name = var.generator_flavor
}

data "openstack_compute_flavor_v2" "coordinator" {
  name = var.coordinator_flavor
}

data "openstack_images_image_v2" "debian" {
  name        = var.image_name
  most_recent = true
}

resource "openstack_compute_keypair_v2" "bench" {
  name       = "rsedge-bench"
  public_key = var.ssh_public_key
}

locals {
  rps_per_generator = floor(150000 / var.generator_count)

  coordinator_user_data = templatefile("${path.module}/cloud-init-coordinator.yaml.tpl", {
    generator_count = var.generator_count
  })
}

resource "openstack_compute_instance_v2" "coordinator" {
  name            = "rsedge-bench-coordinator"
  flavor_id       = data.openstack_compute_flavor_v2.coordinator.id
  image_id        = data.openstack_images_image_v2.debian.id
  key_pair        = openstack_compute_keypair_v2.bench.name
  user_data       = local.coordinator_user_data

  network {
    name = "Ext-Net"
  }

  metadata = {
    role = "rsedge-bench-coordinator"
  }
}

resource "openstack_compute_instance_v2" "generator" {
  count           = var.generator_count
  name            = format("rsedge-bench-gen-%02d", count.index + 1)
  flavor_id       = data.openstack_compute_flavor_v2.generator.id
  image_id        = data.openstack_images_image_v2.debian.id
  key_pair        = openstack_compute_keypair_v2.bench.name

  user_data = templatefile("${path.module}/cloud-init-generator.yaml.tpl", {
    bench_target_url   = var.bench_target_url
    bench_host_header  = var.bench_host_header
    bench_rps_share    = local.rps_per_generator
    bench_seed         = var.bench_seed + count.index
    coordinator_ip     = openstack_compute_instance_v2.coordinator.access_ip_v4
    benchmark_repo     = var.benchmark_repo
    benchmark_repo_ref = var.benchmark_repo_ref
    generator_index    = count.index + 1
  })

  network {
    name = "Ext-Net"
  }

  metadata = {
    role             = "rsedge-bench-generator"
    generator_index  = tostring(count.index + 1)
    bench_target_url = var.bench_target_url
  }

  depends_on = [openstack_compute_instance_v2.coordinator]
}
