# LinkLedger

A tiny single-container web app for tracking how everything in your home
lab is physically and logically cabled together — search a device, see
every port, and see exactly what's on the other end of the cable, including
straight through patch panels.

Single container, SQLite (no separate database to run), full add/edit/
delete control over devices, ports, and cables. A fresh deployment starts
completely empty, ready for you to add your own topology.

## What's inside

- **Backend:** Python + FastAPI, serving a small JSON API and the static
  frontend. Data lives in a single SQLite file.
- **Frontend:** plain HTML/CSS/JS — no build step, no framework, just three
  static files served directly.
- **Data model:** Devices → Ports → Cables. A port can be "paired" with
  another port on the same device (used for patch panel front/rear
  pass-through) — tracing a connection walks cables *and* pairs, so asking
  "what's this NAS NIC connected to" resolves all the way through the patch
  panel to the actual switch port automatically.

Everything (device/port/cable CRUD, the trace/pass-through logic, auth,
the path-finder graph search, Backup/Restore round-tripping, PoE
carry-forward) has been unit-tested against real topology data, and the
UI has been exercised end-to-end with an automated browser test under
both the admin and viewer accounts (search, add/edit/delete devices, bulk
port add with range patterns like `Port[1-8]`, patch-panel paired-port
bulk add, connect/disconnect ports, editing speed/VLAN/PoE on a port, the
path finder, Backup/Restore, the reset flow, duplicate-name and
port-already-in-use error handling). Schema migrations are also tested
directly: an older database loaded against newer code gets every
column/table added automatically, with existing data left untouched. The
Dockerfile itself is straightforward (standard `python:3.12-slim` + pip
install + uvicorn); if you hit anything odd on first boot, please open an
issue.

## Setting up accounts

LinkLedger has exactly two accounts (admin and viewer), signed into with an
in-app login form. Both accounts are created automatically the very first
time the app boots against a brand-new, empty database:

| Account | Username | Password |
|---|---|---|
| admin (full read/write) | `admin` | **`linkledger-admin`** -- documented here, change it after your first login |
| viewer (read-only) | `viewer` | a random password, generated fresh for this install |

- **Admin's password is a known default, on purpose**, so you always know
  how to get into a fresh install: sign in with `admin` /
  `linkledger-admin`, then change it from the **Settings** page. Until you
  do, the app reminds you every time you sign in as admin (a popup
  pointing at Settings and the tutorial) and logs a startup warning.
  **Do this before exposing the app beyond a trusted LAN.**
- **Viewer's password is random and per-install**, and nobody -- including
  the admin -- is told what it is; it's generated once at first boot and
  never logged or exposed anywhere. You don't need to know it: the viewer
  account is entirely optional, and if/when you want to actually use it,
  sign in as **admin** and set a password you know for it from **Settings
  → Viewer account password** (no need to know the old one — this is an
  admin override on a different account, not a self-service change).

**Account usernames are fixed** — always `admin` and `viewer` — and
neither the usernames nor passwords are configurable via environment
variable; there's nothing to set for either account.

**Important:** none of this — the default admin password or the random
viewer password — applies after the very first boot. Once the account rows
exist in the database, it's the source of truth; to change a password
after initial setup, sign in as **admin** and use the **Settings** page in
the app, as described above. (If you're ever locked out entirely with no
way to sign in, the only reset path today is wiping the database via a
fresh volume, which loses your topology data too — there's no separate
"forgot password" recovery yet.)

**Upgrading an existing deployment:** nothing changes for you. This
first-run behavior only applies the very first time the account rows are
created in the database — an existing install already has those rows, so
its accounts, usernames, and passwords are completely untouched by an
upgrade.

Sign-in uses a session cookie rather than the browser's native HTTP Basic
Auth prompt — fine on a trusted home LAN, but don't expose LinkLedger to
the internet without putting it behind something that does real TLS (a
reverse proxy), since both the login form and the session cookie travel
unencrypted over plain HTTP otherwise.

## Deploying via Portainer

LinkLedger isn't a published image on Docker Hub — it's your own code — so
it needs to be *built* somewhere before Portainer can run it. There are two
ways to do that; pick whichever fits how you work.

### Option A — build once over SSH, deploy the image in Portainer (simplest)

1. Copy this whole `linkledger/` folder onto your Docker host, e.g. to
   `/opt/linkledger`. (`scp -r linkledger/ user@yourserver:/opt/`, or unzip
   it there directly.)
2. SSH into the host and build the image once:
   ```bash
   cd /opt/linkledger
   docker build -t linkledger:latest .
   ```
3. In Portainer: **Stacks → Add stack → Web editor**, name it `linkledger`,
   and paste:
   ```yaml
   services:
     linkledger:
       image: linkledger:latest
       container_name: linkledger
       restart: unless-stopped
       ports:
         - "8130:8000"
       volumes:
         - patchbook_data:/data

   volumes:
     patchbook_data:
   ```
   No environment variables to set — see "Setting up accounts" above for
   how accounts work (fixed usernames, a documented default password
   for admin, a random one for viewer, both changeable from the app's
   Settings page after your first login).
4. **Deploy the stack.**
5. Whenever you update the code later, re-run the `docker build` command on
   the host, then in Portainer hit **Stacks → linkledger → Pull and
   redeploy** (or just restart the container) to pick up the new image.

### Option B — keep the code in a git repo, let Portainer build it

If you'd rather push this to a private GitHub repo (or any git server
reachable from your Docker host):

1. Push the `linkledger/` folder to a repo.
2. In Portainer: **Stacks → Add stack → Repository**, point it at the repo
   and the `docker-compose.yml` at its root (the one included here, which
   already has `build: .` set).
3. **Deploy the stack.** Portainer will clone the repo and build the image
   itself. Redeploying the stack later re-pulls and rebuilds.

Either way, the app listens on port **8000** inside the container; both
examples above map it to **8130** on the host — change that if it collides
with something. Once it's up, visit `http://<your-server-ip>:8130`.

## First run

On first boot, a brand-new deployment creates `/data/linkledger.db`
(SQLite) completely empty — no demo devices, ports, or cables to delete
before you can start documenting your own topology. Upgrading an existing
deployment instead finds and reuses your existing database automatically —
whatever's already in it carries over untouched. Every restart after that
reuses the same file via the Docker volume.

## Backing up

Easiest option: open **Settings** in the app (top right, next to Help) and
click **Backup** — downloads a single .zip with everything in it
(devices, ports, cables, your Sites list, and your Device roles / Interface
speeds picker settings, plus a small file noting when it was made and
which version made it). Available to both accounts. Restore it, or move
your data to another instance, with **Restore** on the same page
(admin only) — this replaces your existing data with what's in the zip;
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

- **Search bar** — type a device name (or role/model), pick it from the
  dropdown.
- **Device view** — its own "Device" tab, separate from Browse devices, so
  the device grid and a specific device's page never share the same
  screen. Every port, and what it traces to. Patch panels get a special
  two-column view (device side / switch side) since each of their
  numbered ports is really two ports (front + rear) wired straight through.
  Long device names truncate with an ellipsis and show the full name on
  hover, anywhere they'd otherwise overflow.
- **Print** — every device page has a Print button next to Edit/Delete
  that gives you a clean, paper-friendly version of that device's info and
  full port table, with the app's search bar/tabs/buttons stripped out.
- **+ Add device / + New cable / + Add port(s) / + Add N paired ports** —
  the second is for wiring two arbitrary devices together by picking both
  ends from scratch, without opening either device's page first; the last
  one is for patch panels, and creates however many front/rear pairs you
  ask for in one go, already linked.
- **Back/forward** — the browser's own back and forward buttons step
  through your LinkLedger view history (Device A → Device B → back →
  Device A), the same as any normal site.
- **Connect / disconnect (🔗 / ✕ icons)** — wire two ports together or
  unplug them. Device pickers are type-to-search fields; a port already in
  use is still selectable (its label says what it's currently connected
  to) rather than disabled, so moving a cable to an occupied port is one
  step — pick it and confirm the warning — instead of disconnecting first.
  If a device has no ports at all yet, a "+ Add a new port..." option lets
  you create one right there instead of leaving the dialog. See the Help
  page for the exact steps and how the overwrite warning works. From a
  port's own 🔗 icon you can also choose a wireless/virtual link to an AP
  Group or Virtual Switch instead of a cable.
- **Edit port (pencil icon)** — rename a port, set its speed, and — for
  ports on a Switch or Router/Firewall device, or a port joined to an AP
  Group / Virtual Switch — tag it with VLAN(s), or (Switch / Router-Firewall
  only) mark it as supplying PoE.
- **Roles** — a fixed list (Switch, Patch Panel, Router/Firewall,
  Hypervisor, NAS, Client, Server, Access Point, Appliance, AP Group,
  Virtual Switch, Internet, Other), picked from the dropdown in the
  Add/Edit device modal, with a matching type filter above the device grid
  on the Browse tab. Not user-editable.
- **AP Groups / Virtual Switches** — devices with no physical ports of
  their own, for things that don't have one fixed cable end: a wireless
  client reachable through any of several access points, or a VM/container
  reached through its host's internal bridge. See the Help page for how
  uplinks and members work.
- **Internet role + site-to-site tunnels** — give your WAN/ISP connection
  its own documentation-only Internet device, and model a real IPSec/
  WireGuard tunnel between two routers as a directly-cabled port pair so
  path finder can trace through it.
- **LAGs** — bond two or more of a device's own ports into one labeled
  logical link (each member keeps its own individual cable) from the
  **+ Add LAG** button on a device's page.
- **PoE tags** — mark a Switch or Router/Firewall port as supplying PoE
  (edit-port modal) and a device of any role as requiring it (Add/Edit
  device modal); connections show whether power is actually being
  supplied.
- **Path finder tab** — search for two devices (and the specific NIC on
  each), see the physical path between them with per-segment speeds and a
  VLAN/routing note; the path itself respects VLAN boundaries on switches
  rather than just noting them, and routes through AP Groups / Virtual
  Switches (picking whichever uplink gives the shortest route, by default)
  the same way it routes through a Switch. If the NIC you picked is linked
  to an AP Group / Virtual Switch with more than one uplink, a "Via AP" /
  "Via uplink" dropdown lets you pin the search to one specific uplink
  instead of leaving it to the automatic shortest-route pick.
- **Reports tab** — read-only data-quality checks (devices missing a site/
  model/role, site values not in your managed list, ports missing a speed,
  unused ports, AP Groups / Virtual Switches with no uplinks, devices with
  no ports, and PoE requirements not actually being met), each linking
  straight to the device in question.
- **Settings** (top right) — a separate page for every administrative
  action: **Sites** manages the list the Site dropdown offers (add/rename/
  delete — no fixed built-in list, since every homelab's locations are
  different); **Device roles** and **Interface speeds** are sets of
  checkboxes controlling which of the fixed roles / recognized speeds show
  up in the Add/Edit device Role dropdown and a port's speed dropdown,
  respectively (roles/speeds themselves stay fixed — this just hides ones
  you'll never use); **Backup** downloads a single .zip with everything in
  it — devices, ports, cables, your Sites list, and your Device roles /
  Interface speeds picker settings (available to both accounts);
  **Restore** (admin only) replaces your data with what's in an uploaded
  backup .zip, auto-detecting each file's type from its CSV columns the
  same way import always has; **Change your password** lets the admin
  account change its own password; **Viewer account password** lets the
  admin set the viewer account's password directly (the viewer has no
  self-service password change of its own); **Clear all connections**
  (admin only) permanently disconnects every cable and wireless/virtual
  link while leaving devices and ports themselves in place (patch-panel
  pairing and LAG groupings are unaffected); and **Reset data** (admin
  only) wipes every device/port/cable for a clean start, and also clears
  Sites and resets Device roles / Interface speeds back to their full
  default.
- **Log out** (top right) — ends your session on this device/browser and
  returns to the sign-in screen.
- **Help** (top right, and in the footer) — a plain-language walkthrough
  of all of the above. Its first section links to a bundled **tutorial**
  with screenshots (a quick-start plus a complete guide covering every
  feature and edge case) built on a small made-up example network, along
  with that same example network as a downloadable backup .zip so you can
  restore it and try everything hands-on.

## Ideas for future work

This is deliberately still an iterative build — nothing below is
required, just ideas for once you've kicked the tires:

- A "search by cable" or "unused ports" view, if that turns out useful.
- TLS/reverse-proxy guidance if you want to reach this from outside your
  LAN.

Feedback and pull requests are welcome — please open an issue if you hit
something rough.

## License

LinkLedger is licensed under the GNU Affero General Public License v3.0
(AGPL-3.0) — see [`LICENSE`](LICENSE) for the full text. Copyright (C)
2026 LinkLedger contributors.

In short: you're free to run, modify, and redistribute this code, including
commercially, as long as any distributed or network-served modified
version stays licensed under AGPL-3.0 and makes its source available to
its users. This summary isn't a substitute for the license text itself.
