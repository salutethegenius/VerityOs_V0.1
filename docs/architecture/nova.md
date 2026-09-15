# Nova

Nova is the VerityOS AI operator. Phase 9 runs inside this monorepo and talks only to Verity Core, including Connector Gateway for governed Meta publishing. Nova never receives Page access tokens and never calls Graph HTTP itself.

Production Content-Loop remains the live Slack/Railway system until an explicit cutover. This repository does not change that deployment.

Brands are plug-ins. Core Nova modules must not hardcode brand names.

Skills: `nova.social.draft`, `nova.research`, `nova.drafting`.

Nova authenticates with an **organization-scoped** service credential (`knowledge.read`, `models.read`, `executions.write`). It must not use `platform.cross_org`.

Non-production startup:

```bash
uvicorn verityos_nova.app.main:create_runtime_app --factory --host 0.0.0.0 --port 8090
```

The factory constructs `PostgresStore`, `VerityCoreClient`, and `HttpSlackClient`. Tests inject `MemoryStore` / `FakeSlackClient` / a fake Core client. Missing runtime env fails closed.

After approval, Slack shows **Publish Now** / **Schedule**. Those buttons call Core `POST /internal/v1/executions/:id/connectors/actions` with the already-approved artifact hash.

See [connectors.md](connectors.md), [nova-phase8.md](../migration/nova-phase8.md), and [nova-behavior.md](../migration/nova-behavior.md).
