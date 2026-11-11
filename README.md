# WorkQuiz / Bored@Work

Office tournament voting app with three public surfaces:

- `/` landing page
- `/voting` public voting page
- `/admin` admin portal

## Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Persistence

Production must use Postgres persistence. Set `DATABASE_URL` on Railway before deploying. The app refuses to use file storage in production unless `WORKQUIZ_ALLOW_FILE_STORE=true` is explicitly set, because file storage can be wiped by redeploys.

Local development and tests can still use `data/workquiz.json` when `DATABASE_URL` is not set.

## Backups

- **By hand:** a signed-in admin can download everything from the Backup card on `/admin` (`GET /api/admin/backup`).
- **Nightly pull:** `GET /api/backup/export` returns the same file to a request signed with an Ed25519 key. Set `BACKUP_PUBLIC_KEY` to the base64 SPKI body of the public key (`openssl pkey -in KEY -pubout -outform DER | base64 -w0`). Without it the address answers 404. The caller sends `x-backup-timestamp` (Unix seconds) and `x-backup-signature` (base64 signature over `boredatwork-backup-export:TIMESTAMP`), valid for five minutes. The private key never goes near this app.

The file is `{ kind, version, exportedAt, store }`. `store` is exactly what the `workquiz_store` row holds.

## Round Start Pings

Set `WORKQUIZ_ROUND_START_PING_URL` to send a GET ping when a public tournament round starts. The app records round ping state in the bracket store so status checks and redeploys do not spam repeated messages.

## Migrating Existing JSON Data

After provisioning Railway Postgres and setting `DATABASE_URL`, migrate any existing JSON store before deploying:

```bash
npm run migrate:postgres
```

You can pass a custom JSON path if needed:

```bash
npm run migrate:postgres -- path/to/workquiz.json
```

## Railway Cutover Checklist

Do not deploy while a tournament is live.

1. Confirm no tournament is live.
2. Provision Railway Postgres.
3. Set `DATABASE_URL` on the app service.
4. Run `npm run migrate:postgres` against the Railway database if there is JSON data to preserve.
5. Deploy.
6. Verify `/api/status`, `/voting`, `/admin`, vote submission, and round advancement.
