output "load_balancer_id" {
  value       = cloudflare_load_balancer.owlette.id
  description = "Cloudflare load balancer ID."
}

output "monitor_id" {
  value       = cloudflare_load_balancer_monitor.health.id
  description = "Health monitor ID (GET /api/health)."
}

output "pool_ids" {
  value = {
    railway = cloudflare_load_balancer_pool.railway.id
    vercel  = cloudflare_load_balancer_pool.vercel.id
  }
  description = "Origin pool IDs."
}
