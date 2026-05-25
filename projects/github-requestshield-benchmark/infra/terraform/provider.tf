terraform {
  required_version = ">= 1.5"
  required_providers {
    openstack = {
      source  = "terraform-provider-openstack/openstack"
      version = "~> 1.50"
    }
  }
}

# OVH Public Cloud talks OpenStack. Credentials come from `terraform.tfvars`
# (do NOT commit it). Generate them with:
#   openstack application credential create rsedge-bench -f shell > clouds.env
provider "openstack" {
  auth_url            = var.os_auth_url
  region              = var.os_region
  user_domain_name    = var.os_user_domain_name
  project_domain_name = var.os_project_domain_name
  tenant_id           = var.os_project_id
  user_name           = var.os_user_name
  password            = var.os_password
}
