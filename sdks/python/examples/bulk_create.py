"""bulk-create roosts from a csv.

Mirrors docs/api/examples/bulk-create.md. Idempotency is automatic — the
SDK generates one ``Idempotency-Key`` per ``create()``; re-runs replay
cached responses for already-created rows. Transient 5xx + 429 are
retried by the SDK's default policy; permanent 4xx bubble.

Required env vars::

    ROOST_TOKEN — site:<id>:write scope on every site referenced in the csv

Usage::

    python bulk_create.py path/to/roosts.csv

CSV shape (header required)::

    siteId,roostName,targets
    kiosk-01,lobby-display,machine-a|machine-b
"""

from __future__ import annotations

import asyncio
import csv
import os
import sys
from dataclasses import dataclass

from roost import Roost, RoostApiError


@dataclass(slots=True)
class Row:
    site_id: str
    name: str
    targets: list[str]


def parse_csv(path: str) -> list[Row]:
    rows: list[Row] = []
    with open(path, newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        if reader.fieldnames != ["siteId", "roostName", "targets"]:
            raise ValueError("csv must start with header: siteId,roostName,targets")
        for row in reader:
            if not any(row.values()):
                continue
            rows.append(Row(
                site_id=(row["siteId"] or "").strip(),
                name=(row["roostName"] or "").strip(),
                targets=[t.strip() for t in (row["targets"] or "").split("|") if t.strip()],
            ))
    return rows


async def main() -> int:
    token = os.environ.get("ROOST_TOKEN")
    api_url = os.environ.get("ROOST_BASE", "https://owlette.app")
    csv_path = sys.argv[1] if len(sys.argv) > 1 else None

    if not token or not csv_path:
        print("usage: ROOST_TOKEN=... python bulk_create.py <roosts.csv>", file=sys.stderr)
        return 1

    rows = parse_csv(csv_path)
    created = failed = 0

    async with Roost(token=token, api_url=api_url) as client:
        for row in rows:
            try:
                res = await client.roosts.create(
                    site_id=row.site_id, name=row.name, targets=row.targets,
                )
                print(f"[bulk-create] ok  site={row.site_id} roost={res.roost_id} name={row.name}")
                created += 1
            except RoostApiError as err:
                failed += 1
                print(f"[bulk-create] fail site={row.site_id} name={row.name}  {err.status} {err.code}: {err.problem.get('detail')}", file=sys.stderr)
            except Exception as err:
                failed += 1
                print(f"[bulk-create] fail site={row.site_id} name={row.name}  {err}", file=sys.stderr)

    print(f"[bulk-create] done — created={created} failed={failed} total={len(rows)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
