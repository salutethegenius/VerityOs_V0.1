# Government communications demo (10–15 minutes)

Synthetic institutional demo only. The organization is **VerityOS Government Communications Demo**. It does not represent a real ministry.

Documents are marked **SYNTHETIC DEMO DOCUMENT / NOT OFFICIAL GOVERNMENT POLICY**.

## Pre-demo setup

```bash
cp .env.example .env
# set VERITY_PROFILE=demo, SESSION_SECRET (32+ chars, not the dev default),
# DATABASE_URL, CORS_ORIGIN, VERITY_DATA_DIR, VERITY_EMBEDDING_PROVIDER=mock
docker compose up -d postgres
pnpm install
pnpm db:migrate
pnpm build
VERITY_PROFILE=demo VERITY_DEMO_RESET=1 pnpm demo:reset
# passwords print once; also tmp/verity-demo-seed.json
pnpm demo:check   # after Core/Nova/Shell are up
```

Start Core, Nova (`NOVA_DEV_MODE=1`), Shell, and `node scripts/meta-mock.mjs` as in [development.md](../deployment/development.md), using the demo seed tokens (`NOVA_*` from `tmp/verity-demo-seed.json`). Point `META_GRAPH_BASE` at the mock.

Fallback if the mock model or mock Meta is down: still log in and show Knowledge + Audit of prior records; do not improvise a live publish. Say “external action is mocked in this candidate.”

## Roles (obvious demo emails)

| Role | Email (default) | What they can do |
| --- | --- | --- |
| Director | `director@verity-demo.local` | Admin, approve, publish, verify |
| Communications Officer | `communications@verity-demo.local` | Draft, request approval, cannot self-approve |
| Analyst | `analyst@verity-demo.local` | Research only; cannot social-draft or publish |

Passwords are printed once at seed. Development profile uses documented demo passwords; demo profile generates them.

## Click-by-click

1. Open the Shell login screen. Explain: browser → Shell → Core only.
2. Sign in as Communications Officer.
3. Nova → Social Draft. Brand **Demo Civil Protection**. Topic:

   > Using approved institutional guidance only, prepare a public advisory telling residents what actions to take and what information should not yet be published.

4. Check **Institutional Guidance (Synthetic Demo)**. Generate draft.
5. Point at citations (approved source versions) and the sealed artifact hash. Explain Model Router selected the allowed mock/local model.
6. Status is pending approval. Log out.
7. Sign in as Director. Command → Approvals. Show the **exact** artifact / hash. Approve.
8. Nova → open the same run → **Publish Now** (mock Meta). Confirm **Published**.
9. Audit → open the Verity Record → **Verify Record**. Show **Integrity Verified** and **Provenance Verified**.
10. Optional: export evidence (hashes/metadata). Same artifact drafted, approved, and acted on.

## What to explain

- Command policy, Knowledge approval, and Connector Gateway sit behind Core.
- Connector idempotency is what prevents duplicate external posts; rate limits are in-process only.
- Verify language is integrity + provenance, not factual truth.

## What to avoid claiming

- Fact Verified, Truth Verified, certified government product, signed chain head, production Content-Loop, real Meta/Slack, Hummingbird hardware.

## Expected outcomes

- Officer draft cites the synthetic pack.
- Director cannot be skipped; self-approval is denied.
- Analyst cannot publish (Command / permission deny; no connector call).
- Strict research on an unsupported question shows **Insufficient approved evidence**.

## Time

About 12 minutes if seed and preflight already passed.
