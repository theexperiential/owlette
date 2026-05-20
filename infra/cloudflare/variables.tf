variable "account_id" {
  type        = string
  description = "Cloudflare account ID that owns the load-balancing monitor + pools."
}

variable "zone_id" {
  type        = string
  description = "Cloudflare zone ID for the owlette.app zone."
}

variable "app_host" {
  type        = string
  description = "Public hostname the LB serves; also sent to origins as the Host header so Railway/Vercel route + TLS correctly."
  default     = "owlette.app"
}

variable "railway_origin" {
  type        = string
  description = "Railway origin hostname (PRIMARY pool), e.g. owlette-prod-xxxx.up.railway.app — hostname only, no scheme."
}

variable "vercel_origin" {
  type        = string
  description = "Vercel origin hostname (STANDBY pool), e.g. owlette-eight.vercel.app — hostname only, no scheme."
}

variable "notification_email" {
  type        = string
  description = "Optional email for pool health notifications. Empty disables notifications."
  default     = ""
}
