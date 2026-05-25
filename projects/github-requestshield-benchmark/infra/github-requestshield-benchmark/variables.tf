# --- OpenStack / OVH Public Cloud credentials --------------------------------

variable "os_auth_url" {
  type    = string
  default = "https://auth.cloud.ovh.net/v3"
}
variable "os_region" {
  type        = string
  description = "OVH region (e.g. GRA11, SBG7, DE1)."
}
variable "os_user_domain_name" {
  type    = string
  default = "Default"
}
variable "os_project_domain_name" {
  type    = string
  default = "Default"
}
variable "os_project_id" {
  type        = string
  description = "OVH Public Cloud project (tenant) ID."
}
variable "os_user_name" {
  type        = string
  description = "OpenStack user (typically from `openstack application credential create`)."
}
variable "os_password" {
  type        = string
  description = "OpenStack password / application credential secret."
  sensitive   = true
}

# --- Benchmark sizing --------------------------------------------------------

variable "generator_count" {
  type        = number
  description = "Number of load generators. 12 yields ~150 k rps with b2-15."
  default     = 12
}
variable "generator_flavor" {
  type    = string
  default = "b2-15"
}
variable "coordinator_flavor" {
  type    = string
  default = "s1-2"
}
variable "image_name" {
  type    = string
  default = "Debian 12"
}
variable "ssh_public_key" {
  type        = string
  description = "Contents of your SSH public key (e.g. file(\"~/.ssh/id_ed25519.pub\"))."
}

# --- Benchmark target --------------------------------------------------------

variable "bench_target_url" {
  type        = string
  description = "Full URL to POST to, e.g. https://api.foo-preprod.requestshield.ovh/api/v1/analyze"
}
variable "bench_host_header" {
  type        = string
  description = "Host header sent in the synthetic payload (and TLS SNI). Usually matches the URL host."
}
variable "bench_seed" {
  type        = number
  default     = 42
  description = "Campaign seed (deterministic payload reproduction)."
}
variable "bench_api_key" {
  type        = string
  default     = ""
  sensitive   = true
  description = "Optional value from RSEDGE_API_KEYS. Sent as X-API-Key by k6. Leave empty if /analyze is open in the target env."
}

# --- Optional: where to fetch the k6 script ----------------------------------

variable "benchmark_repo" {
  type        = string
  description = "Public/cloneable URL of this repo. cloud-init clones it on each generator."
  default     = "https://stash.ovh.net/scm/~bruno.bontemps/requestshield-benchmark.git"
}
variable "benchmark_repo_ref" {
  type    = string
  default = "dev/bbontemp/init-benchmark"
}
