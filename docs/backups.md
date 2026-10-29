# JSON backups by email

Backups run every Sunday at 01:00 Asia/Kolkata when BACKUP_WEEKLY_ENABLED=true,
and after every backend startup by default, including deployments, redeployments,
and process restarts. Startup delivery begins 15 seconds after the database is
ready; SMTP delivery and export time are additional. Set BACKUP_ON_STARTUP=false
to disable it, or BACKUP_STARTUP_DELAY_MS to change the delay. Each run writes a private JSON
file and emails a signed download link. No Google Drive credentials are needed.

Set these in Backend/.env or Backend/src/.env (deployment environment variables
have priority):

```dotenv
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
BACKUP_EMAIL_TO=
BACKUP_PUBLIC_BASE_URL=https://api.abhishekfinance.cloud
BACKUP_LINK_TTL_HOURS=168
BACKUP_STORAGE_DIR=/var/lib/abhifinance/backups
BACKUP_WEEKLY_ENABLED=true
BACKUP_ON_STARTUP=true
```

Set SMTP_HOST to your provider's SMTP hostname, or set SMTP_SERVICE to a
Nodemailer service preset. Port 465 uses implicit TLS; port 587 requires STARTTLS.
SMTP_FROM defaults to SMTP_USER. BACKUP_EMAIL_TO is the destination address (or
comma-separated addresses). The recipient is configured only on the server.
Fill in the blank values before enabling delivery. Set BACKUP_LINK_TTL_HOURS=168
in Coolify as well: an existing value of 24 overrides the new seven-day default.
BACKUP_DAILY_ENABLED is no longer used; replace it with BACKUP_WEEKLY_ENABLED.
Already emailed links retain their original expiry; only new links get seven days.

Install dependencies with `npm ci` and restart the backend after configuration.
SMTP acceptance does not guarantee inbox delivery; check the recipient's spam
folder and provider delivery logs if necessary.

BACKUP_PUBLIC_BASE_URL must be the public HTTPS API origin. Downloads go to
/api/v1/backups/download?token=... on this origin. Links expire after the configured
number of hours and authenticate the download without requiring a login. Treat
them as secrets. Configure the reverse proxy to omit query strings from access
logs for this endpoint; application request logs already omit query strings.
Signing uses JWT_SECRET with a backup-specific signature prefix; rotating it
invalidates previously issued links.

The storage directory defaults to Backend/backups and is ignored by Git. It must
be writable by the backend process and kept outside web server static roots.
Use a persistent volume in production. Multiple backend replicas need the same
shared volume and signing key so any instance can serve the emailed link.
Expired files are removed when the next backup starts; expiry is enforced on
every download even before file cleanup. Files remain downloadable after a
process restart if the volume and signing key are preserved.

## API

- GET /api/v1/backups/json: authenticated JSON download; requires EXPORT_REPORTS.
- POST /api/v1/backups/email: generate and email a link to BACKUP_EMAIL_TO;
  requires MANAGE_SETTINGS. Returns filename and expiry, without exposing the link.
- GET /api/v1/backups/download?token=...: signed, expiring download from email.

The previous /excel and /google-drive routes are removed.

## Format and limits

The JSON contains formatVersion, generatedAt, exportType, and collections keyed
by MongoDB collection name. Records retain nested objects and arrays. Collections
are exported sequentially using cursors; they do not represent an atomic database
snapshot if writes occur during export. Dates are serialized as ISO strings and
ObjectIds as strings. This is a sanitized data export: passwords, refresh-token
fields, and selected encrypted identity fields are excluded, matching the prior
Excel export. It is not a complete restorable MongoDB backup, and there is no
restore/import endpoint. Keep database-native backups separately if full recovery
is required.

Tests: `node tests/backup.test.js` (mock database/SMTP, real temporary files).
