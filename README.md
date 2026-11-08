# Semi Zalo AI

A single Node.js/TypeScript application with a Svelte 5 dashboard, directly integrated `zca-js`, PostgreSQL memory, Ollama vision & tool-calling, and SearXNG. Replaces the Zalo Gateway + n8n workflow. No Tor, Ahmia, or video analysis.

## Features

- Zalo QR login and persisted private session (from the actual earlier `zca-js` gateway code).
- Incoming private messages, images via Zalo's `photo-*.zdn.vn` CDN, text normalization; group messages ignored.
- Approval/disable/block/unblock, first-contact default deny, PostgreSQL message deduplication.
- Ollama model with `web_search` function calling, SearXNG JSON results, configurable system prompt.
- Conversation memory saved in PostgreSQL by thread, bounded model context.
- Web dashboard for service status, QR login, users, messages, conversation history, logs and prompt.
- In-process concurrency-limited queue and per-conversation serial processing.
- No secrets baked into repository; strong first-admin bootstrap; HTTP-only signed session cookies.

## Standalone project (no Docker Compose)

This repository builds **one Docker image** for the Node.js API, Zalo gateway, and Svelte dashboard. PostgreSQL, Ollama and SearXNG are separately managed services. No Compose manifest or database container is bundled. The app does not create a PostgreSQL instance.

### First-run configuration

1. Provision an accessible PostgreSQL database. Set only `DATABASE_URL` at runtime. It must contain a stable credential (provider credentials are encrypted with a key derived from this URL and a DB-backed salt).
2. Give the container a durable, private volume at `/app/data` for `zca-js` session files. Run exactly one active instance for a Zalo account.
3. Build locally, or push this repository and use the GitHub Actions workflow to publish to `ghcr.io/<owner>/<repo>:latest`.

```bash
docker build -t semi-zalo-ai:local .
docker volume create semi-zalo-session
docker run -d --name semi-zalo-ai \
  --restart unless-stopped -p 3000:3000 \
  -e DATABASE_URL='postgresql://USER:PASSWORD@DB_HOST:5432/DB_NAME' \
  -v semi-zalo-session:/app/data \
  semi-zalo-ai:local
```

Open `http://localhost:3000` for the first-run admin registration. **No Ollama, SearXNG or Zalo setup is mandatory**. In **Modules**, independently configure Ollama, SearXNG, AI Processing and Zalo Gateway (QR Login). Enable Zalo only after you have disabled the old gateway instance.

For Dokploy, deploy the published GHCR image as an **Application**, attach a private volume at `/app/data`, set only `DATABASE_URL`, attach the database network and route port `3000` via the reverse proxy. For a public domain, set Public Origin through the UI. HTTPS is recommended for admin login.

### GitHub Actions: publish to GHCR

`.github/workflows/docker.yml` builds the dashboard/backend, runs tests, invokes your requested `abxst/action/strict@v3` validation step, then builds and pushes the Docker image to GitHub Container Registry. Trigger: pushes to `main`/`master`, version tags or manual dispatch. PRs only run verification.

**Important:** I could not verify the public availability, expected inputs or even the `v3` ref of `abxst/action/strict`. The workflow includes exactly the reference requested, but if it is private, missing, or needs extra inputs, the `verify` job will fail and image publishing will be blocked. Validate its action.yml and access permissions in GitHub before depending on this pipeline. GitHub standard Docker Buildx build/push steps are separately defined.

Your repository's Actions workflow needs the `packages: write` permission to publish to GHCR. If the package is private, the deployment host needs appropriate GHCR pull credentials.

## Configuration & security

- Ollama and SearXNG providers (URLs, models, result count, optional credentials) live in PostgreSQL `app_connections`. The UI validates inputs and checks the corresponding provider before saving. SearXNG must allow JSON search results.
- Runtime, feature toggles and the system prompt live in PostgreSQL `app_settings`. The Zalo session itself is stored in a private persistent volume, not in a browser or environment variable.
- Credentials are encrypted using AES-256-GCM with a key derived from the database URL and the per-installation salt in `app_settings`. Changing the database password/URL without a coordinated key migration will make old encrypted credentials unreadable. Back up the database, especially `crypto_salt`, and preserve existing DB credentials during upgrades.
- All module control endpoints require an authenticated admin cookie and same-origin checks. Protect the admin UI with HTTPS. Do not expose PostgreSQL to the public Internet.
- Zalo is disabled by default for new installations, and login QR is **only requested on demand**. On startup, an enabled gateway attempts to restore the stored session without prompting for QR. Disabling the module disconnects it but preserves the session; explicit Logout deletes the local session.

## Operations

- Health: `GET /health` (returns DB + gateway state); no auth required.
- All `/api/*` except `/api/auth/login` and `/api/auth/me` require signed login cookie.
- Messages denied before approval are recorded but not answered. Group messages are ignored.
- Vision is image-only. Video and other attachments receive an explicit inability-to-analyze response.
- Inbound deduplication: PostgreSQL unique `(thread_id,message_id)`.
- System prompt updates apply on next message.
- To run without Zalo initially, keep the Zalo module disabled in **Modules**; no simulator endpoint is exposed.

## Current implementation limitations

This is an initial functional project, **not an audited production release**. It has not been end-to-end tested against your actual Zalo account, model, Docker network, or secrets. In-process queues are not durable: a restart can leave `queued`/`processing` messages without retry. Add a durable PostgreSQL/Valkey worker and retry policies before using it for critical traffic. There is no automated import from existing n8n's `zalo_users`, `zalo_messages` and `zalo_ai_chat_history`. Multi-instance Zalo Gateway, MFA, adaptive rate limiting, attachment retention/expiry, video, observability exporters and stronger RBAC are future enhancements. The first login QR may need a fresh session if the source library changes. `zca-js` uses an unofficial client and may risk Zalo account restrictions.

## Development

```bash
npm install
npm run build
npm test
npm run dev -w @semi/server
npm run dev -w @semi/web
```

Set `NODE_ENV=development` and run PostgreSQL/Ollama/SearXNG locally. Vite proxies `/api` to the backend on port 3000.

## Independent Zalo module (Admin → Modules)

Zalo Gateway, Ollama, SearXNG and AI Processing are independently configurable on the **Modules** page. Admin account setup never requires connecting a provider.

Zalo controls: Enable, Disable, QR Login, Reconnect (stored session only), Disconnect (keep session), Logout (delete local session). QR and status refresh automatically every two seconds. Only a logged-in admin can see the QR. Disabling does not delete a valid session. Logout does not guarantee server-side invalidation at Zalo.

Authenticated API endpoints: `GET /api/gateway`, `GET /api/gateway/qr`, `POST /api/gateway/enable` with JSON `{ "enabled": true|false }`, `POST /api/gateway/qr/start`, `POST /api/gateway/reconnect`, `POST /api/gateway/disconnect`, and `POST /api/gateway/logout`.

Use a single running Zalo instance per account and volume. The `zca-js` client is unofficial and its protocol may change. Runtime integration and full Docker build have not been validated against a real Zalo login in this environment. In-process AI queues are not durable across crashes; assess this before production rollout.

## AI Processing module (Admin → Modules)

The **AI Processing** card is on the Modules page, alongside Zalo, Ollama and SearXNG. It exposes:

- Enable/disable accepting **new** AI processing tasks (`aiEnabled`, defaults to true). In-progress tasks are not interrupted. Zalo still ingests and records messages when AI is disabled.
- AI concurrency (1–10), chat context size (1–30 message pairs), tool rounds (1–5), inference timeout (10–600 seconds), maximum image size, and Zalo send delay.
- **Save AI Processing** persists the full validated runtime settings in PostgreSQL `app_settings`; configuration is applied without replacing the database URL environment variable.
- **Test AI Inference** invokes the saved Ollama chat model with a simple fixed prompt, without writing chat history or sending Zalo messages. It is authenticated and deliberately does not execute SearXNG queries. A successful Ollama connection test is not the same as a successful model inference test.
- **AI Agent & Prompt** remains a separate page for updating the system prompt.

For an existing database, `aiEnabled` defaults to `true` when absent from the saved runtime JSON. The `app_settings` schema does not require a migration.
