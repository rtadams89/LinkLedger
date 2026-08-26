# LinkLedger

A tiny single-container web app for tracking how everything in your network
is physically and logically connected together. You can search a device, see
every port, and see exactly what's on the other end of the cable, including
straight through patch panels.

Single container, SQLite (no separate database to run), full add/edit/
delete control over devices, ports, and cables. A fresh deployment starts
completely empty, ready for you to add your own topology.

This is not intended for enterprise use but would work perfectly for a
home-lab, small office setup, or other small to medium networks. It
supports multiple sites, which can be kept isolated or connected together
(e.g., with a VPN).

This is not an IPAM system and is not a CMDB/inventory system. It doesn't
deal with layer 3 (IP addresses) or above, and only tracks how things are
physically and logically connected.

## What's inside

- **Backend:** Python + FastAPI + SQLite file.
- **Frontend:** plain HTML/CSS/JS.

The Dockerfile itself is straightforward (standard `python:3.12-slim` + pip
install + uvicorn); if you hit anything odd on first boot, please open an
issue.

## Setting up accounts

LinkLedger has exactly two accounts (admin and viewer), signed into with an
in-app login form. Both accounts are created automatically the very first
time the app boots against a brand-new, empty database:

- **Admin's password is a known default, on purpose**, so you always know
  how to get into a fresh install: sign in with `admin` /
  `linkledger-admin`, then change it from the **Settings** page. Until you
  do, the app reminds you every time you sign in as admin and logs a startup
  warning.
- **Viewer's password is random and per-install**, and nobody, including
  the admin, is told what it is; it's generated once at first boot and
  never logged or exposed anywhere. You don't need to know it: the viewer
  account is entirely optional, and if/when you want to actually use it,
  sign in as **admin** and set a password you know for it from **Settings
  → Viewer account password**.

**Important:** none of this applies after the very first boot. Once the account rows
exist in the database, it's the source of truth; to change a password
after initial setup, sign in as **admin** and use the **Settings** page in
the app, as described above.

**Upgrading an existing deployment:** This first-run behavior only applies
the very first time the account rows are created in the database — an
existing install already has those rows, so its accounts, usernames,
and passwords are completely untouched by an upgrade.

LinkLedger communicates over plain HTTP. Don't expose it to the internet
without putting it behind something that does real TLS (a reverse proxy),
since both the login form and the session cookie travel unencrypted
otherwise.

## Deploying with Docker

LinkLedger isn't a published image on Docker Hub, so you need to build it
locally.

1. Copy this whole `linkledger/` folder onto your Docker host, e.g. to
   `/opt/linkledger`. (`scp -r linkledger/ user@yourserver:/opt/`, or unzip
   it there directly.)
2. SSH into the host and build and start it:
   ```bash
   docker compose up -d
   ```
The app listens on port **8000** inside the container and is mapped to
**8130** on the host. Change that port if it collides with an existing container.
Once it's up, visit `http://<your-server-ip>:8130`.

## First run

On first boot, a brand-new deployment creates `/data/linkledger.db`
(SQLite) completely empty. Upgrading an existing deployment instead finds
and reuses your existing database automatically. Every restart after that
reuses the same file via the Docker volume.

## Backing up

Easiest option: open **Settings** in the app (top right, next to Help) and
click **Backup**, which downloads a single .zip with everything in it.
Restore it, or move your data to another instance, with **Restore** on the
same page, which replaces your existing data with what's in the zip;
see the Help page for the details, including how it handles a backup
trimmed down to just one or two of the CSVs, and how replacing devices or
ports can cascade into clearing ports/cables.

For a raw database-level backup instead, the entire database is one file:
the `patchbook_data` Docker volume, specifically `/data/linkledger.db`
inside it.

```bash
docker cp linkledger:/data/linkledger.db ./linkledger-backup-$(date +%F).db
```

To restore that, stop the container, `docker cp` the backup file back to
the same path, and start it again.

## Using it

The app has a built-in **Help** section, including a tutorial with sample
data you can load into the app to play around with. The best way to get up
and running is to work through it.

## License

LinkLedger is licensed under the GNU Affero General Public License v3.0
(AGPL-3.0) — see [`LICENSE`](LICENSE) for the full text. Copyright (C)
2026 LinkLedger contributors.

In short: you're free to run, modify, and redistribute this code, including
commercially, as long as any distributed or network-served modified
version stays licensed under AGPL-3.0 and makes its source available to
its users. This summary isn't a substitute for the license text itself.