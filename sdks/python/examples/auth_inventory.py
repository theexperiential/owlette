"""Auth and inventory workflow.

Required env:
    OWLETTE_TOKEN

Optional:
    OWLETTE_API_URL defaults to https://owlette.app
    OWLETTE_SITE_ID overrides the site selection
"""

from __future__ import annotations

import asyncio
import os
import sys

from roost import Roost, RoostApiError


async def main() -> int:
    token = os.environ.get("OWLETTE_TOKEN")
    api_url = os.environ.get("OWLETTE_API_URL") or "https://owlette.app"
    configured_site_id = os.environ.get("OWLETTE_SITE_ID")

    if not token:
        print("missing env var: OWLETTE_TOKEN", file=sys.stderr)
        return 1

    async with Roost(token=token, api_url=api_url) as client:
        try:
            identity = await client.account.whoami()
            version = await client.account.version()
            sites = await client.sites.list()

            print("api", version.current, "supported", ",".join(version.supported))
            print("caller", identity.email or identity.user_id or "api-key")
            print("key", identity.key.key_prefix if identity.key else "session")
            print("sites", len(sites))
            for site in sites:
                print(f"site {site.id} {site.name}")

            site_id = configured_site_id or identity.primary_site_id
            if site_id is None and sites:
                site_id = sites[0].id
            if not site_id:
                print("no site available for machine inventory")
                return 0

            machines = await client.machines.list(site_id)
            print("selected site", site_id, "machines", len(machines))
            for machine in machines:
                heartbeat = machine.last_heartbeat or "never"
                print(
                    f"machine {machine.id} {machine.name} "
                    f"online={machine.online} heartbeat={heartbeat}"
                )
            return 0
        except RoostApiError as err:
            detail = err.problem.get("detail")
            print(f"api error {err.status} {err.code}: {detail}", file=sys.stderr)
            if err.request_id:
                print(f"request_id: {err.request_id}", file=sys.stderr)
            return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
