#!/usr/bin/env python3
"""
Test bout-en-bout de la ressource fbm-updater contre un VRAI serveur (Next.js + PostgreSQL + stockage local),
avec interopérabilité launcher/CLI Rust : la CLI installe, la ressource met à jour, la CLI relit l'état, etc.

Prérequis : base PostgreSQL vide `fbm_fivem_e2e` (propriétaire fbm), `cargo build --release -p fbm-core --bin fbm-cli`
dans launcher/ (le build de web/ est fait au besoin).
    python3 fivem/e2e/run.py            (FBM_NODE=/chemin/node16 pour tester avec Node 16)
"""
import hashlib, io, json, os, signal, subprocess, tempfile, time, urllib.request, zipfile, shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WEB, CLI = ROOT / "web", ROOT / "launcher/target/release/fbm-cli"
HARNESS = ROOT / "fivem/fbm-updater/test/harness.js"
PORT = 3302
BASE = f"http://localhost:{PORT}"
DB = os.environ.get("E2E_DATABASE_URL", "postgresql://fbm:fbm@localhost:5432/fbm_fivem_e2e")
STORE = tempfile.mkdtemp(prefix="fbm-fx-store-")
WORK = Path(tempfile.mkdtemp(prefix="fbm-fx-work-"))
SRV = WORK / "server-data"
ADMIN_ID = "999999999999999999"
passed = 0


def check(cond, label, detail=""):
    global passed
    if not cond:
        print(f"  ✗ {label}\n{detail}")
        raise SystemExit(f"ÉCHEC : {label}")
    passed += 1
    print(f"  ✓ {label}")


def sha(b):
    return hashlib.sha256(b).hexdigest()


def psql(sql):
    subprocess.run(["psql", DB, "-q", "-c", sql], check=True, capture_output=True)


def http(method, path, cookie=None, body=None, raw=None):
    headers, data = {}, None
    if cookie:
        headers["Cookie"] = f"fbm_session={cookie}"
        if method != "GET":
            headers["Origin"] = BASE
    if body is not None:
        data, headers["Content-Type"] = json.dumps(body).encode(), "application/json"
    if raw is not None:
        data, headers["Content-Type"] = raw, "application/zip"
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def publish(version, files):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for p, c in files.items():
            z.writestr(p, c)
    st, up = http("POST", f"/api/admin/versions/upload?version={version}", "tok-admin", raw=buf.getvalue())
    assert st == 200, up
    st, _ = http("POST", f"/api/admin/versions/{up['id']}/publish", "tok-admin", body={"notifyDiscord": False})
    assert st == 200
    return up


def fx(*args, token):
    """Ressource fbm-updater dans le harnais FiveM : `boot` (redémarrage) ou `cmd …` (console txAdmin)."""
    p = subprocess.run([os.environ.get("FBM_NODE", "node"), str(HARNESS), "--dir", str(SRV), "--api", BASE, "--token", token, *args], capture_output=True, text=True, timeout=120)
    if p.returncode != 0:
        raise SystemExit(f"harnais en erreur :\n{p.stdout}\n{p.stderr}")
    return p.stdout


def cli(*args, token):
    p = subprocess.run([str(CLI), "--api", BASE, "--token", token, "--dir", str(SRV), *args], capture_output=True, text=True)
    return p.returncode, p.stdout + p.stderr.replace("\r", "\n")


def read(rel):
    try:
        return (SRV / rel).read_text()
    except FileNotFoundError:
        return "<absent>"


env = {**os.environ, "DATABASE_URL": DB}
if not (WEB / ".next/BUILD_ID").exists():
    print("Build de production absent : npx next build …")
    subprocess.run(["npx", "next", "build"], cwd=WEB, env=env, check=True, capture_output=True)
subprocess.run(["npx", "prisma", "migrate", "deploy"], cwd=WEB, env=env, check=True, capture_output=True)
psql('TRUNCATE "AuditLog","Download","Change","Version","Session","LauncherToken","Announcement","Setting","MediaAsset","User" CASCADE')
server = subprocess.Popen(
    ["npx", "next", "start", "-p", str(PORT)], cwd=WEB, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
    env={**env, "NODE_ENV": "production", "APP_URL": BASE, "APP_SECRET": "e2e-fivem-secret-e2e-fivem-secret-123", "DISCORD_CLIENT_ID": "1",
         "DISCORD_CLIENT_SECRET": "x", "DISCORD_GUILD_ID": "2", "ADMIN_DISCORD_IDS": ADMIN_ID, "STORAGE_DRIVER": "local", "STORAGE_LOCAL_DIR": STORE},
)
try:
    for _ in range(60):
        try:
            urllib.request.urlopen(BASE + "/api/public/latest"); break
        except Exception:
            time.sleep(1)
    for key, did in (("admin", ADMIN_ID), ("member", "100000000000000001")):
        psql(f"""INSERT INTO "User"(id,"discordId",username,"inGuild","lastLoginAt") VALUES ('u_{key}','{did}','{key}',true,now());
                 INSERT INTO "Session"(id,"tokenHash","userId","expiresAt") VALUES ('s_{key}','{sha(f"tok-{key}".encode())}','u_{key}',now()+interval '1 day');""")
    st, tok = http("POST", "/api/account/tokens", "tok-member", body={"name": "txAdmin"})
    token = tok["token"]

    V1 = {
        "server.cfg": "ensure fbm-updater\nensure core\n",
        "resources/[fbm]/fbm-updater/fxmanifest.lua": "fx_version 'cerulean'",
        "resources/core/fxmanifest.lua": "fx_version 'cerulean'",
        "resources/core/main.lua": "print('core v1')\n",
        "resources/core/config.lua": "Config = { v = 1 }",
        "resources/old/fxmanifest.lua": "fx_version 'cerulean'",
    }
    V2 = {**V1, "resources/core/main.lua": "print('core v2')\n", "resources/core/config.lua": "Config = { v = 2 }",
          "resources/garage/fxmanifest.lua": "fx_version 'cerulean' -- garage", "server.cfg": "ensure fbm-updater\nensure core\nensure garage\n"}
    del V2["resources/old/fxmanifest.lua"]

    print("Installation v1.0.0 avec le launcher (CLI Rust)")
    publish("1.0.0", V1)
    rc, out = cli("update", token=token)
    check(rc == 0 and "OK : v1.0.0" in out, "fbm-cli installe v1.0.0", out)
    (SRV / "server.cfg").write_text("ensure fbm-updater\nensure core\nsv_hostname 'MON SERVEUR'\n")
    (SRV / "resources/core/config.lua").write_text("Config = { v = 1, perso = true }")

    print("Mise à jour v1.1.0 depuis la console txAdmin (ressource)")
    publish("1.1.0", V2)
    out = fx("cmd", "status", token=token)
    check("Installée : v1.0.0" in out and "Disponible : v1.1.0" in out, "fbm status relit l'état écrit par le launcher Rust", out)
    out = fx("cmd", "update", token=token)
    check("v1.1.0 téléchargée et vérifiée" in out and "Redémarrez le serveur" in out, "fbm update prépare v1.1.0", out)
    check("2 fichier(s) à télécharger" in out and "1 à supprimer" in out and "2 config(s) protégée(s)" in out, "plan : 2 téléchargements, 1 suppression, 2 configs protégées", out)
    check(read("resources/core/main.lua") == "print('core v1')\n", "rien n'est modifié tant que le serveur n'a pas redémarré")
    out = fx("boot", token=token)
    check("Mise à jour appliquée : v1.0.0 → v1.1.0" in out, "au redémarrage : mise à jour appliquée", out)
    check(read("resources/core/main.lua") == "print('core v2')\n" and read("resources/garage/fxmanifest.lua").endswith("garage"), "fichiers modifiés / ajoutés installés")
    check(read("resources/old/fxmanifest.lua") == "<absent>" and not (SRV / "resources/old").exists(), "ressource obsolète supprimée")
    check("MON SERVEUR" in read("server.cfg") and "perso" in read("resources/core/config.lua"), "server.cfg et config.lua personnalisés conservés")

    print("Interopérabilité inverse")
    rc, out = cli("status", token=token)
    check(rc == 0 and "Installé : v1.1.0" in out and "0 à écrire" in out, "le launcher Rust relit l'état écrit par la ressource", out)

    print("Rollback décidé sur le site, puis version précise")
    _, vs = http("GET", "/api/admin/versions", "tok-admin")
    v10 = next(v for v in vs["versions"] if v["version"] == "1.0.0")
    http("POST", f"/api/admin/versions/{v10['id']}/rollback", "tok-admin")
    fx("cmd", "update", token=token)
    out = fx("boot", token=token)
    check("v1.1.0 → v1.0.0" in out and read("resources/core/main.lua") == "print('core v1')\n", "rollback appliqué au redémarrage", out)
    check(read("resources/garage/fxmanifest.lua") == "<absent>" and (SRV / "resources/old/fxmanifest.lua").exists(), "ressource ajoutée retirée, ressource supprimée rétablie")
    fx("cmd", "update", "1.1.0", token=token)
    fx("boot", token=token)
    check(read("resources/core/main.lua") == "print('core v2')\n", "« fbm update 1.1.0 » : version précise installée")

    print("Réparation")
    p = SRV / "resources/core/main.lua"
    p.write_text("print('core v9')\n")  # même taille
    out = fx("cmd", "repair", token=token)
    check("1 fichier(s) à télécharger" in out, "fbm repair détecte la corruption de même taille", out)
    fx("boot", token=token)
    check(p.read_text() == "print('core v2')\n", "fichier réparé au redémarrage")

    print("Statistiques, maintenance, jeton révoqué")
    _, stats = http("GET", "/api/admin/stats", "tok-admin")
    row = next(v for v in stats["perVersion"] if v["version"] == "1.1.0")
    check(row["update"] >= 2 and row["repair"] >= 1, f"rapports envoyés au site (v1.1.0 : {row['update']} mises à jour, {row['repair']} réparation)")
    http("PUT", "/api/admin/settings", "tok-admin", body={"maintenance": {"enabled": True, "message": "Migration en cours"}})
    out = fx("cmd", "update", token=token)
    check("Échec : Migration en cours" in out, "maintenance : message du site affiché dans txAdmin", out)
    http("PUT", "/api/admin/settings", "tok-admin", body={"maintenance": {"enabled": False, "message": ""}})
    http("DELETE", f"/api/account/tokens/{tok['id']}", "tok-member")
    out = fx("cmd", "status", token=token)
    check("Jeton refusé" in out, "jeton révoqué : message clair", out)
    print(f"\n{passed} vérifications OK")
finally:
    try:
        os.killpg(os.getpgid(server.pid), signal.SIGTERM)
    except Exception:
        pass
    shutil.rmtree(STORE, ignore_errors=True)
    shutil.rmtree(WORK, ignore_errors=True)
