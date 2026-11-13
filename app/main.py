import asyncio
import logging
import secrets
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Request, UploadFile, File
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.base import BaseHTTPMiddleware

from . import crud, csvio, db, pathfind, pfsense

VERSION = "1.8.2"
log = logging.getLogger("linkledger")

# ---------------------------------------------------------------------------
# Auth: one admin (read-write) account, one viewer (read-only) account,
# signed in via an in-app login form and a server-side session cookie.
#
# On first boot, seed_accounts() creates both accounts: admin gets a known
# default password (see README), viewer gets a random one. After that, the
# database is the source of truth; account usernames and passwords are
# managed from the Settings page, not environment variables.
# ---------------------------------------------------------------------------

_DEFAULT_ADMIN_PASS = "linkledger-admin"

SESSION_COOKIE = "ll_session"
SESSION_MAX_AGE = 60 * 60 * 24 * 30  # 30 days

# In-memory session store. Does not survive a restart.
SESSIONS: dict[str, dict] = {}

# Paths reachable without a session: the SPA shell, its static assets, and
# the auth-bootstrapping endpoints below.
PUBLIC_PATHS = {"/", "/api/login", "/api/logout", "/api/whoami", "/api/meta"}
PUBLIC_PREFIXES = ("/static/",)


ADMIN_USER = "admin"
VIEWER_USER = "viewer"


def _session_for(request: Request):
    sid = request.cookies.get(SESSION_COOKIE)
    return SESSIONS.get(sid) if sid else None


def _set_session_cookie(response: Response, role: str, username: str) -> None:
    sid = secrets.token_urlsafe(32)
    SESSIONS[sid] = {"role": role, "username": username}
    response.set_cookie(SESSION_COOKIE, sid, httponly=True, samesite="lax", max_age=SESSION_MAX_AGE)


class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        sess = _session_for(request)
        request.state.role = sess["role"] if sess else None
        request.state.username = sess["username"] if sess else None

        path = request.url.path
        if path in PUBLIC_PATHS or path.startswith(PUBLIC_PREFIXES):
            return await call_next(request)
        if sess is None:
            return JSONResponse(status_code=401, content={"detail": "not signed in"})
        return await call_next(request)


def require_admin(request: Request):
    if getattr(request.state, "role", None) != "admin":
        raise HTTPException(status_code=403, detail="read-only user -- sign in as the admin account to make changes")


app = FastAPI(title="LinkLedger")
app.add_middleware(AuthMiddleware)


@app.middleware("http")
async def add_static_cache_headers(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/static/"):
        # Without an explicit Cache-Control header, browsers fall back to
        # heuristic caching and can keep serving an old app.js/style.css
        # for a long time on an ordinary reload -- only a hard refresh
        # (which bypasses the cache entirely) was picking up changes.
        # "no-cache" still lets the browser keep a cached copy, but makes
        # it revalidate with the server first every time; StaticFiles
        # already sends ETag/Last-Modified, so an unchanged file comes
        # back as a cheap 304 and only an actually-changed one is
        # re-downloaded.
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.on_event("startup")
def startup():
    db.init_db()
    # Only used the first time accounts are seeded.
    viewer_seed_pass = secrets.token_urlsafe(16)
    with db.session() as conn:
        crud.seed_accounts(conn, ADMIN_USER, _DEFAULT_ADMIN_PASS, VIEWER_USER, viewer_seed_pass)
        default_admin = crud.is_default_password(conn, "admin", _DEFAULT_ADMIN_PASS)
    if default_admin:
        log.warning(
            "LinkLedger's admin account still has its default password. Sign in as admin "
            "and change it from the Settings page before exposing this beyond a trusted "
            "network -- see the README for the default credentials. (The app also reminds "
            "you of this on every admin login until it's changed.)"
        )


# pfSense device-discovery polling -- a single shared loop, woken every
# ~60s, that checks each enabled pfsense_instances row's own poll_minutes
# due-check (see crud.sync_due_pfsense_instances). One loop rather than one
# task per instance so instances can be added/edited/removed/toggled at
# runtime without juggling a dynamic set of background tasks.
_PFSENSE_POLL_TICK_SECONDS = 60


@app.on_event("startup")
async def start_pfsense_poller():
    async def loop():
        while True:
            try:
                with db.session() as conn:
                    crud.sync_due_pfsense_instances(conn)
            except Exception:
                log.exception("pfSense discovery poll loop hit an unexpected error")
            await asyncio.sleep(_PFSENSE_POLL_TICK_SECONDS)

    asyncio.create_task(loop())


def handle(fn, *args, **kwargs):
    with db.session() as conn:
        try:
            return fn(conn, *args, **kwargs)
        except crud.NotFoundError as e:
            raise HTTPException(status_code=404, detail=str(e))
        except crud.ConflictError as e:
            raise HTTPException(status_code=409, detail=str(e))
        except pfsense.PfsenseError as e:
            raise HTTPException(status_code=502, detail=str(e))


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class DeviceIn(BaseModel):
    name: str
    role: str = ""
    model: str = ""
    site: str = ""
    notes: str = ""
    poe_required: bool = False
    # None means "pick the default from role" (crud.create_device hides
    # Clients by default); an explicit value always wins.
    show_on_map: Optional[bool] = None


class DeviceUpdate(BaseModel):
    name: Optional[str] = None
    role: Optional[str] = None
    model: Optional[str] = None
    site: Optional[str] = None
    notes: Optional[str] = None
    poe_required: Optional[bool] = None
    ports_per_row: Optional[int] = None
    show_on_map: Optional[bool] = None


class PositionIn(BaseModel):
    x: float
    y: float


class PortLayoutModeIn(BaseModel):
    mode: str


class PortGridPositionIn(BaseModel):
    port_id: int
    grid_row: int
    grid_col: int


class PortGridPositionsIn(BaseModel):
    positions: list[PortGridPositionIn]


class PortIn(BaseModel):
    name: str
    speed: str = ""
    vlans: str = ""
    poe_supply: bool = False


class PortsBulkIn(BaseModel):
    names: list[str]
    speed: str = ""
    poe_supply: bool = False


class PatchPanelIn(BaseModel):
    count: int
    start: int = 1


class PortUpdate(BaseModel):
    name: Optional[str] = None
    speed: Optional[str] = None
    vlans: Optional[str] = None
    poe_supply: Optional[bool] = None
    # Layer 2 only -- see ports.mac_address. Empty string clears it.
    mac_address: Optional[str] = None


class PairIn(BaseModel):
    pair_port_id: Optional[int] = None


class VirtualLinkIn(BaseModel):
    virtual_switch_id: Optional[int] = None


class UplinkIn(BaseModel):
    port_id: int


class LagIn(BaseModel):
    name: str


class PortLagIn(BaseModel):
    lag_id: Optional[int] = None


class CableIn(BaseModel):
    port_a_id: int
    port_b_id: int
    label: str = ""
    overwrite: bool = False


class SiteIn(BaseModel):
    name: str


class EnabledSpeedsIn(BaseModel):
    speeds: list[str]


class EnabledRolesIn(BaseModel):
    roles: list[str]


class EnabledReportsIn(BaseModel):
    reports: list[str]


class PfsenseInstanceIn(BaseModel):
    name: str
    site: str = ""
    base_url: str = ""
    api_key: str = ""
    verify_tls: bool = True
    enabled: bool = True
    poll_minutes: int = 20


class PfsenseInstanceUpdate(BaseModel):
    name: Optional[str] = None
    site: Optional[str] = None
    base_url: Optional[str] = None
    # Blank/omitted leaves the stored key untouched -- see
    # crud.update_pfsense_instance (a GET never returns the real key).
    api_key: Optional[str] = None
    verify_tls: Optional[bool] = None
    enabled: Optional[bool] = None
    selected_interfaces: Optional[list[str]] = None
    poll_minutes: Optional[int] = None


class ImportDiscoveredIn(BaseModel):
    name: str
    role: str = ""
    model: str = ""
    site: Optional[str] = None
    notes: str = ""


class LinkDiscoveredIn(BaseModel):
    port_id: int


class LoginIn(BaseModel):
    username: str
    password: str


class ChangePasswordIn(BaseModel):
    current_password: str
    new_password: str


class SetViewerPasswordIn(BaseModel):
    new_password: str


# ---------------------------------------------------------------------------
# Devices
# ---------------------------------------------------------------------------

@app.get("/api/devices")
def api_list_devices(q: Optional[str] = None):
    return handle(crud.list_devices, q)


@app.post("/api/devices", dependencies=[Depends(require_admin)])
def api_create_device(body: DeviceIn):
    return handle(crud.create_device, body.name, body.role, body.model, body.site, body.notes, body.poe_required,
                  body.show_on_map)


@app.get("/api/devices/{device_id}")
def api_get_device_full(device_id: int):
    with db.session() as conn:
        try:
            device = crud.get_device(conn, device_id)
            ports = crud.list_ports(conn, device_id)
            for p in ports:
                hops = crud.trace(conn, p["id"])
                p["trace"] = hops
                p["effective_speed"] = crud.effective_speed(p, hops)
                p["effective_vlans"] = crud.effective_vlans(hops)
                p["poe_supplied"] = crud.effective_poe_supplied(hops)
            lags = crud.list_lags(conn, device_id)
            lag_name_by_port = {m["id"]: lag["name"] for lag in lags for m in lag["members"]}
            for p in ports:
                p["lag_name"] = lag_name_by_port.get(p["id"])
            device["ports"] = ports
            device["lags"] = lags
            if device["role"] in db.VIRTUAL_SWITCH_ROLES:
                device["uplinks"] = crud.list_uplinks(conn, device_id)
                device["members"] = crud.list_members(conn, device_id)
            return device
        except crud.NotFoundError as e:
            raise HTTPException(status_code=404, detail=str(e))


@app.put("/api/devices/{device_id}", dependencies=[Depends(require_admin)])
def api_update_device(device_id: int, body: DeviceUpdate):
    return handle(crud.update_device, device_id, **body.model_dump())


@app.delete("/api/devices/{device_id}", dependencies=[Depends(require_admin)])
def api_delete_device(device_id: int):
    handle(crud.delete_device, device_id)
    return {"ok": True}


@app.put("/api/devices/{device_id}/position", dependencies=[Depends(require_admin)])
def api_set_device_position(device_id: int, body: PositionIn):
    return handle(crud.set_device_position, device_id, body.x, body.y)


# ---------------------------------------------------------------------------
# Free-form port layout -- see crud.set_port_layout_mode / set_port_grid_positions.
# ---------------------------------------------------------------------------

@app.put("/api/devices/{device_id}/port-layout-mode", dependencies=[Depends(require_admin)])
def api_set_port_layout_mode(device_id: int, body: PortLayoutModeIn):
    return handle(crud.set_port_layout_mode, device_id, body.mode)


@app.put("/api/devices/{device_id}/port-grid", dependencies=[Depends(require_admin)])
def api_set_port_grid_positions(device_id: int, body: PortGridPositionsIn):
    return handle(crud.set_port_grid_positions, device_id, [p.model_dump() for p in body.positions])


# ---------------------------------------------------------------------------
# Ports
# ---------------------------------------------------------------------------

@app.post("/api/devices/{device_id}/ports", dependencies=[Depends(require_admin)])
def api_create_port(device_id: int, body: PortIn):
    return handle(crud.create_port, device_id, body.name, speed=body.speed, vlans=body.vlans,
                  poe_supply=body.poe_supply)


@app.post("/api/devices/{device_id}/ports/bulk", dependencies=[Depends(require_admin)])
def api_create_ports_bulk(device_id: int, body: PortsBulkIn):
    return handle(crud.create_ports_bulk, device_id, body.names, speed=body.speed, poe_supply=body.poe_supply)


@app.post("/api/devices/{device_id}/patch-panel", dependencies=[Depends(require_admin)])
def api_create_patch_panel(device_id: int, body: PatchPanelIn):
    pairs = handle(crud.create_patch_panel_ports, device_id, body.count, start=body.start)
    return {"pairs_created": len(pairs)}


@app.put("/api/ports/{port_id}", dependencies=[Depends(require_admin)])
def api_update_port(port_id: int, body: PortUpdate):
    return handle(crud.update_port, port_id, name=body.name, speed=body.speed, vlans=body.vlans,
                  poe_supply=body.poe_supply, mac_address=body.mac_address)


@app.delete("/api/ports/{port_id}", dependencies=[Depends(require_admin)])
def api_delete_port(port_id: int):
    handle(crud.delete_port, port_id)
    return {"ok": True}


@app.post("/api/ports/{port_id}/pair", dependencies=[Depends(require_admin)])
def api_set_pair(port_id: int, body: PairIn):
    return handle(crud.set_pair, port_id, body.pair_port_id)


@app.post("/api/ports/{port_id}/virtual-link", dependencies=[Depends(require_admin)])
def api_set_virtual_link(port_id: int, body: VirtualLinkIn):
    return handle(crud.set_virtual_link, port_id, body.virtual_switch_id)


@app.get("/api/ports/{port_id}/trace")
def api_trace(port_id: int):
    return handle(crud.trace, port_id)


@app.delete("/api/ports/{port_id}/cable", dependencies=[Depends(require_admin)])
def api_disconnect_port(port_id: int):
    handle(crud.delete_cable_by_port, port_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Cables
# ---------------------------------------------------------------------------

@app.get("/api/cables")
def api_list_cables():
    return handle(crud.list_cables)


@app.post("/api/cables", dependencies=[Depends(require_admin)])
def api_create_cable(body: CableIn):
    cable_id = handle(crud.create_cable, body.port_a_id, body.port_b_id, body.label, body.overwrite)
    return {"id": cable_id}


@app.delete("/api/cables/{cable_id}", dependencies=[Depends(require_admin)])
def api_delete_cable(cable_id: int):
    handle(crud.delete_cable, cable_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Map -- every device (with its ports/LAGs) and every cable in one call.
# ---------------------------------------------------------------------------

@app.get("/api/topology")
def api_get_topology():
    return handle(crud.get_topology)


# ---------------------------------------------------------------------------
# Virtual switches (AP Group / Virtual Switch) -- uplinks. An uplink is a
# real port elsewhere in the topology that also serves as this virtual
# switch's link to the network. Members are set via
# /api/ports/{port_id}/virtual-link above instead.
# ---------------------------------------------------------------------------

@app.get("/api/devices/{device_id}/uplinks")
def api_list_uplinks(device_id: int):
    return handle(crud.list_uplinks, device_id)


@app.post("/api/devices/{device_id}/uplinks", dependencies=[Depends(require_admin)])
def api_add_uplink(device_id: int, body: UplinkIn):
    uplink_id = handle(crud.add_uplink, device_id, body.port_id)
    return {"id": uplink_id}


@app.delete("/api/uplinks/{uplink_id}", dependencies=[Depends(require_admin)])
def api_remove_uplink(uplink_id: int):
    handle(crud.remove_uplink, uplink_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# LAGs -- bond two or more of a device's own physical ports into one
# logical link.
# ---------------------------------------------------------------------------

@app.get("/api/devices/{device_id}/lags")
def api_list_lags(device_id: int):
    return handle(crud.list_lags, device_id)


@app.post("/api/devices/{device_id}/lags", dependencies=[Depends(require_admin)])
def api_create_lag(device_id: int, body: LagIn):
    lag_id = handle(crud.create_lag, device_id, body.name)
    return {"id": lag_id}


@app.delete("/api/lags/{lag_id}", dependencies=[Depends(require_admin)])
def api_delete_lag(lag_id: int):
    handle(crud.delete_lag, lag_id)
    return {"ok": True}


@app.post("/api/ports/{port_id}/lag", dependencies=[Depends(require_admin)])
def api_set_port_lag(port_id: int, body: PortLagIn):
    return handle(crud.set_port_lag, port_id, body.lag_id)


# ---------------------------------------------------------------------------
# Roles -- fixed list (see db.ROLES). Which ones show up in the Add/Edit
# device Role dropdown is configurable via /api/settings/roles below.
# ---------------------------------------------------------------------------

@app.get("/api/roles")
def api_list_roles():
    return [{"name": r} for r in db.ROLES]


@app.get("/api/settings/roles")
def api_get_role_settings():
    with db.session() as conn:
        return {"all": list(db.ROLES), "enabled": crud.get_enabled_roles(conn)}


@app.put("/api/settings/roles", dependencies=[Depends(require_admin)])
def api_set_role_settings(body: EnabledRolesIn):
    return {"enabled": handle(crud.set_enabled_roles, body.roles)}


# ---------------------------------------------------------------------------
# Sites -- a user-managed picklist for devices.site. Read access for
# everyone; creating, renaming, and deleting are admin-only.
# ---------------------------------------------------------------------------

@app.get("/api/sites")
def api_list_sites():
    return handle(crud.list_sites)


@app.post("/api/sites", dependencies=[Depends(require_admin)])
def api_create_site(body: SiteIn):
    return handle(crud.create_site, body.name)


@app.put("/api/sites/{site_id}", dependencies=[Depends(require_admin)])
def api_rename_site(site_id: int, body: SiteIn):
    return handle(crud.rename_site, site_id, body.name)


@app.delete("/api/sites/{site_id}", dependencies=[Depends(require_admin)])
def api_delete_site(site_id: int):
    handle(crud.delete_site, site_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Interface speed picker settings -- which recognized speeds show up in
# the port speed dropdown.
# ---------------------------------------------------------------------------

@app.get("/api/settings/speeds")
def api_get_speed_settings():
    with db.session() as conn:
        return {"all": list(crud.SPEED_MBPS.keys()), "enabled": crud.get_enabled_speeds(conn)}


@app.put("/api/settings/speeds", dependencies=[Depends(require_admin)])
def api_set_speed_settings(body: EnabledSpeedsIn):
    return {"enabled": handle(crud.set_enabled_speeds, body.speeds)}


# ---------------------------------------------------------------------------
# Reports -- read-only data-quality checks (see crud.data_quality_report).
# ---------------------------------------------------------------------------

@app.get("/api/reports")
def api_reports():
    return handle(crud.data_quality_report)


# ---------------------------------------------------------------------------
# Reports-tab visibility setting -- which of the checks above are shown.
# ---------------------------------------------------------------------------

@app.get("/api/settings/reports")
def api_get_report_settings():
    with db.session() as conn:
        return {
            "all": [{"key": k, "title": t} for k, t in crud.REPORT_DEFS],
            "enabled": crud.get_enabled_reports(conn),
        }


@app.put("/api/settings/reports", dependencies=[Depends(require_admin)])
def api_set_report_settings(body: EnabledReportsIn):
    return {"enabled": handle(crud.set_enabled_reports, body.reports)}


# ---------------------------------------------------------------------------
# pfSense device discovery -- one or more pfSense instances (each via the
# third-party pfSense-pkg-API package, see app/pfsense.py), polled for ARP
# + DHCP data on their own interval, feeding the Discovery staging list
# below. Settings (instance CRUD/test/interfaces) are admin-only; the
# Discovery list and its resolving actions (ignore/import/link) are too,
# since they write data.
# ---------------------------------------------------------------------------

@app.get("/api/settings/pfsense", dependencies=[Depends(require_admin)])
def api_list_pfsense_instances():
    return handle(crud.list_pfsense_instances)


@app.post("/api/settings/pfsense", dependencies=[Depends(require_admin)])
def api_create_pfsense_instance(body: PfsenseInstanceIn):
    return handle(crud.create_pfsense_instance, name=body.name, site=body.site, base_url=body.base_url,
                  api_key=body.api_key, verify_tls=body.verify_tls, enabled=body.enabled,
                  poll_minutes=body.poll_minutes)


@app.put("/api/settings/pfsense/{instance_id}", dependencies=[Depends(require_admin)])
def api_update_pfsense_instance(instance_id: int, body: PfsenseInstanceUpdate):
    return handle(crud.update_pfsense_instance, instance_id, **body.model_dump(exclude_unset=True))


@app.delete("/api/settings/pfsense/{instance_id}", dependencies=[Depends(require_admin)])
def api_delete_pfsense_instance(instance_id: int):
    handle(crud.delete_pfsense_instance, instance_id)
    return {"ok": True}


@app.post("/api/settings/pfsense/{instance_id}/test", dependencies=[Depends(require_admin)])
def api_test_pfsense_instance(instance_id: int):
    handle(crud.test_pfsense_instance, instance_id)
    return {"ok": True}


@app.get("/api/settings/pfsense/{instance_id}/interfaces", dependencies=[Depends(require_admin)])
def api_list_pfsense_interfaces(instance_id: int):
    return handle(crud.list_pfsense_interfaces, instance_id)


@app.post("/api/discovery/sync", dependencies=[Depends(require_admin)])
def api_sync_discovery(instance_id: Optional[int] = None):
    if instance_id is not None:
        handle(crud.sync_pfsense_instance, instance_id)
    else:
        handle(crud.sync_due_pfsense_instances)
    return {"ok": True}


@app.get("/api/discovery", dependencies=[Depends(require_admin)])
def api_list_discovery(status: Optional[str] = "pending", instance_id: Optional[int] = None):
    return handle(crud.list_discovered_devices, status=status, instance_id=instance_id)


@app.post("/api/discovery/{discovered_id}/ignore", dependencies=[Depends(require_admin)])
def api_ignore_discovered(discovered_id: int):
    return handle(crud.ignore_discovered, discovered_id)


@app.post("/api/discovery/{discovered_id}/import", dependencies=[Depends(require_admin)])
def api_import_discovered(discovered_id: int, body: ImportDiscoveredIn):
    return handle(crud.import_discovered, discovered_id, name=body.name, role=body.role, model=body.model,
                  site=body.site, notes=body.notes)


@app.post("/api/discovery/{discovered_id}/link", dependencies=[Depends(require_admin)])
def api_link_discovered(discovered_id: int, body: LinkDiscoveredIn):
    return handle(crud.link_discovered, discovered_id, body.port_id)


# ---------------------------------------------------------------------------
# Path finder
# ---------------------------------------------------------------------------

@app.get("/api/path")
def api_find_path(a: int, b: int, port_a: Optional[int] = None, port_b: Optional[int] = None,
                   uplink_a: Optional[int] = None, uplink_b: Optional[int] = None):
    # uplink_a/uplink_b optionally pin the search to one specific uplink of
    # an AP Group / Virtual Switch the corresponding NIC is a member of.
    return handle(pathfind.find_path, a, b, port_a_id=port_a, port_b_id=port_b,
                  uplink_a_id=uplink_a, uplink_b_id=uplink_b)


# ---------------------------------------------------------------------------
# Backup / Restore -- a single .zip bundling the CSV exports plus a small
# metadata file. Backup is available to both accounts; Restore is admin
# only.
# ---------------------------------------------------------------------------

@app.get("/api/backup")
def api_backup():
    with db.session() as conn:
        data, created_at = csvio.build_backup_zip(conn, VERSION)
    stamp = created_at.replace(":", "").replace("-", "")  # filesystem-friendly
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="linkledger-backup-{stamp}.zip"'},
    )


@app.post("/api/restore", dependencies=[Depends(require_admin)])
async def api_restore(file: UploadFile = File(...)):
    data = await file.read()
    with db.session() as conn:
        try:
            summary = csvio.restore_backup_zip(conn, data)
        except crud.ConflictError as e:
            raise HTTPException(status_code=409, detail=str(e))
    return {"ok": True, "imported": summary}


# ---------------------------------------------------------------------------
# Admin
# ---------------------------------------------------------------------------

@app.post("/api/admin/clear-connections", dependencies=[Depends(require_admin)])
def api_clear_connections():
    handle(crud.clear_all_connections)
    return {"ok": True}


@app.post("/api/admin/reset", dependencies=[Depends(require_admin)])
def api_reset():
    handle(crud.reset_all_data)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Meta
# ---------------------------------------------------------------------------

@app.get("/api/meta")
def api_meta():
    return {"version": VERSION}


@app.get("/api/whoami")
def api_whoami(request: Request):
    role = getattr(request.state, "role", None)
    username = getattr(request.state, "username", None)
    admin_default_password = False
    if role == "admin":
        with db.session() as conn:
            admin_default_password = crud.is_default_password(conn, "admin", _DEFAULT_ADMIN_PASS)
    return {"role": role, "username": username, "admin_default_password": admin_default_password}


# ---------------------------------------------------------------------------
# Auth: sign in/out, change password
# ---------------------------------------------------------------------------

@app.post("/api/login")
def api_login(body: LoginIn, response: Response):
    with db.session() as conn:
        account = crud.verify_login(conn, body.username, body.password)
    if not account:
        raise HTTPException(status_code=401, detail="incorrect username or password")
    _set_session_cookie(response, account["role"], account["username"])
    return {"role": account["role"], "username": account["username"]}


@app.post("/api/logout")
def api_logout(request: Request, response: Response):
    sid = request.cookies.get(SESSION_COOKIE)
    if sid:
        SESSIONS.pop(sid, None)
    response.delete_cookie(SESSION_COOKIE)
    return {"ok": True}


def _invalidate_sessions_for_role(role: str):
    for sid in [s for s, v in SESSIONS.items() if v["role"] == role]:
        SESSIONS.pop(sid, None)


@app.post("/api/account/change-password", dependencies=[Depends(require_admin)])
def api_change_password(body: ChangePasswordIn, request: Request, response: Response):
    # Changes the caller's own account. The viewer has no self-service
    # password change -- see /api/admin/set-viewer-password below.
    role = request.state.role
    if len(body.new_password) < 8:
        raise HTTPException(status_code=400, detail="new password must be at least 8 characters")
    with db.session() as conn:
        account = crud.change_password(conn, role, body.current_password, body.new_password)
    if not account:
        raise HTTPException(status_code=403, detail="current password is incorrect")

    # Invalidate every session on this account, then issue a fresh one so
    # this request isn't logged out too.
    _invalidate_sessions_for_role(role)
    _set_session_cookie(response, account["role"], account["username"])
    return {"ok": True}


@app.post("/api/admin/set-viewer-password", dependencies=[Depends(require_admin)])
def api_set_viewer_password(body: SetViewerPasswordIn):
    # Admin override: sets the viewer's password directly and invalidates
    # every existing viewer session.
    if len(body.new_password) < 8:
        raise HTTPException(status_code=400, detail="new password must be at least 8 characters")
    handle(crud.set_password, "viewer", body.new_password)
    _invalidate_sessions_for_role("viewer")
    return {"ok": True}


# ---------------------------------------------------------------------------
# Frontend
# ---------------------------------------------------------------------------

app.mount("/static", StaticFiles(directory="app/static"), name="static")


@app.get("/")
def index():
    return FileResponse("app/static/index.html")
