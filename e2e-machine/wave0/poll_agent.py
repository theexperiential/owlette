"""Wave 0 spike — agent-faithful device-code poll.

Runs on the AGENT's bundled Python (C:\\ProgramData\\Owlette\\python) so the
HTTP call uses the exact `requests` library + default User-Agent that
configure_site.py uses in production. This is what makes the Cloudflare/UA
question a real test rather than a controller-side approximation.

Deliberately does NOT touch .tokens.enc — it polls with a synthetic machineId
passed on argv and prints the token result as JSON for the Node controller.

Usage: poll_agent.py <api_base> <pair_phrase> <machine_id> <version>
Prints exactly one JSON line on stdout.
"""
import sys
import json
import time

import requests as http_requests  # same import alias configure_site.py uses


def main() -> None:
    api_base, phrase, machine_id, version = sys.argv[1:5]
    url = f"{api_base}/api/agent/auth/device-code/poll"
    out = {
        "reached": False,
        "status": None,
        "cloudflare_blocked": False,
        "polls": 0,
        "error": None,
    }
    deadline = time.time() + 75
    try:
        while time.time() < deadline:
            # No custom headers — mirrors configure_site.py's poll exactly, so
            # this reproduces the agent's real User-Agent against Cloudflare.
            resp = http_requests.post(
                url,
                json={"pairPhrase": phrase, "machineId": machine_id, "version": version},
                timeout=15,
            )
            out["reached"] = True
            out["status"] = resp.status_code
            out["polls"] += 1
            body = resp.text or ""
            lowered = body.lower()

            # Cloudflare bot-block signatures (error 1010 / managed challenge).
            if resp.status_code in (403, 503) and (
                "cloudflare" in lowered or "error 1010" in lowered or "cf-ray" in lowered
            ):
                out["cloudflare_blocked"] = True
                out["error"] = f"cloudflare blocked python-requests ({resp.status_code})"
                break

            if resp.status_code == 202:
                time.sleep(5)
                continue

            if resp.status_code == 200:
                data = resp.json()
                out["accessToken"] = data.get("accessToken")
                out["refreshToken"] = data.get("refreshToken")
                out["siteId"] = data.get("siteId")
                out["expiresIn"] = data.get("expiresIn")
                break

            out["error"] = f"poll {resp.status_code}: {body[:200]}"
            break
    except Exception as exc:  # noqa: BLE001 — spike wants the raw failure
        out["error"] = f"exception: {exc}"

    sys.stdout.write(json.dumps(out))


if __name__ == "__main__":
    main()
