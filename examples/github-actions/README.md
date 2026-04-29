# Owlette GitHub Actions examples

Copy these workflow templates into consumer repositories after the Wave 5.3 package distribution gate is complete.

| file | purpose |
|---|---|
| `roost-deploy.yml` | build an artifact, publish it as a Roost version, and deploy it with the Owlette CLI action |

Required repository configuration:

- secret `OWLETTE_TOKEN`: scoped Owlette API key
- variable `OWLETTE_SITE_ID`: target site id
- variable `OWLETTE_ROOST_ID`: target Roost id
- optional variable `OWLETTE_API_URL`: defaults to `https://owlette.app`

Recommended key scope:

- `site:<site-id>:read`
- `roost:<roost-id>:write,deploy`
