#!/usr/bin/env python3
"""
Test bout-en-bout du parcours complet, contre un VRAI serveur (Next.js + PostgreSQL + stockage local) et un vrai MariaDB :

  admin : base complète v1.0.0 (+ _sql/)  →  joueur : télécharge le ZIP, importe sql/install.sql, lance
  admin : PATCH v1.1.0 (fichiers modifiés + _sql/ + suppression)  →  joueur : « fbm update » (SQL exécuté) puis redémarrage
  nouveau joueur : télécharge le ZIP v1.1.0 → tout est déjà à jour (fichiers ET base de données)
  + interopérabilité avec le launcher Rust, rollback, réparation, maintenance, jeton révoqué.

Prérequis : PostgreSQL (base vide `fbm_fivem_e2e`, propriétaire fbm), MariaDB/MySQL avec un utilisateur fbm/fbm ayant les droits
sur `fivem_%`, `npm ci` dans fivem/test, `cargo build --release -p fbm-core --bin fbm-cli` dans launcher/ (web/ est construit au besoin).
    python3 fivem/e2e/run.py            (FBM_NODE=/chemin/node16 pour tester avec Node 16)
"""
import hashlib, io, json, os, signal, subprocess, tempfile, time, urllib.request, zipfile, shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WEB, CLI = ROOT / "web", ROOT / "launcher/target/release/fbm-cli"
HARNESS = ROOT / "fivem/test/harness.js"
PORT = 3302
BASE = f"http://localhost:{PORT}"
DB = os.environ.get("E2E_DATABASE_URL", "postgresql://fbm:fbm@localhost:5432/fbm_fivem_e2e")
MYSQL = {"user": "fbm", "password": "fbm", "host": "127.0.0.1", "port": "3306"}
STORE = tempfile.mkdtemp(prefix="fbm-fx-store-")
WORK = Path(tempfile.mkdtemp(prefix="fbm-fx-work-"))
SRV = WORK / "server-data"
SRV2 = WORK / "nouveau-joueur"
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


def mysql(db, sql=None, stdin=None):
    cmd = ["mysql", f"-u{MYSQL['user']}", f"-p{MYSQL['password']}", f"-h{MYSQL['host']}", f"-P{MYSQL['port']}", "-N", "-B"]
    if db:
        cmd.append(db)
    if sql:
        cmd += ["-e", sql]
    p = subprocess.run(cmd, input=stdin, capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit(f"mysql : {p.stderr}")
    return p.stdout.strip()


def mysql_url(db):
    return f"mysql://{MYSQL['user']}:{MYSQL['password']}@{MYSQL['host']}:{MYSQL['port']}/{db}"


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


def make_zip(files):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for p, c in files.items():
            z.writestr(p, c)
    return buf.getvalue()


def upload(version, files, query="", changes=None, title=None):
    st, up = http("POST", f"/api/admin/versions/upload?version={version}{query}", "tok-admin", raw=make_zip(files))
    assert st == 200, up
    if changes:
        http("PUT", f"/api/admin/versions/{up['id']}", "tok-admin", body={"title": title, "changes": changes})
    st, _ = http("POST", f"/api/admin/versions/{up['id']}/publish", "tok-admin", body={"notifyDiscord": False})
    assert st == 200
    return up


def download_zip(version, dest):
    st, link = http("POST", f"/api/download/{version}/link", "tok-member")
    assert st == 200, link
    data = urllib.request.urlopen(link["url"]).read()
    assert sha(data) == link["sha256"]
    dest.mkdir(parents=True, exist_ok=True)
    zipfile.ZipFile(io.BytesIO(data)).extractall(dest)
    return data


def fx(*args, token, srv=SRV, db=None):
    """Ressource fbm-updater dans le harnais FiveM : `boot` (redémarrage) ou `cmd …` (console txAdmin). db = base MariaDB (oxmysql)."""
    cmd = [os.environ.get("FBM_NODE", "node"), str(HARNESS), "--dir", str(srv)]
    if db:
        cmd += ["--mysql", mysql_url(db)]
    p = subprocess.run(cmd + ["--api", BASE, "--token", token, *args], capture_output=True, text=True, timeout=120, cwd=HARNESS.parent)
    if p.returncode != 0:
        raise SystemExit(f"harnais en erreur :\n{p.stdout}\n{p.stderr}")
    return p.stdout


def cli(*args, token, srv=SRV):
    p = subprocess.run([str(CLI), "--api", BASE, "--token", token, "--dir", str(srv), *args], capture_output=True, text=True)
    return p.returncode, p.stdout + p.stderr.replace("\r", "\n")


def read(rel, srv=SRV):
    try:
        return (srv / rel).read_text()
    except FileNotFoundError:
        return "<absent>"


env = {**os.environ, "DATABASE_URL": DB}
if not (WEB / ".next/BUILD_ID").exists():
    print("Build de production absent : npx next build …")
    subprocess.run(["npx", "next", "build"], cwd=WEB, env=env, check=True, capture_output=True)
subprocess.run(["npx", "prisma", "migrate", "deploy"], cwd=WEB, env=env, check=True, capture_output=True)
psql('TRUNCATE "AuditLog","Download","Change","Version","Session","LauncherToken","Announcement","Setting","MediaAsset","User" CASCADE')
for d in ("fivem_e2e", "fivem_e2e2"):
    mysql(None, f"DROP DATABASE IF EXISTS `{d}`; CREATE DATABASE `{d}`;")
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

    BASE_SQL = (
        "-- schéma de départ\n"
        "CREATE TABLE users (identifier VARCHAR(60) PRIMARY KEY, name VARCHAR(50), job VARCHAR(20) DEFAULT 'unemployed');\n"
        "INSERT INTO users VALUES ('license:1', 'Admin; le chef', 'police'), ('license:2', 'L''ami', 'mechanic');\n"
        "DELIMITER $$\n"
        "CREATE TRIGGER users_name BEFORE INSERT ON users FOR EACH ROW BEGIN SET NEW.name = TRIM(NEW.name); END$$\n"
        "DELIMITER ;\n"
    )
    V1 = {
        "server.cfg": "ensure oxmysql\nensure fbm-updater\nensure core\n",
        "resources/[fbm]/fbm-updater/fxmanifest.lua": "fx_version 'cerulean'",
        "resources/core/fxmanifest.lua": "fx_version 'cerulean'",
        "resources/core/main.lua": "print('core v1')\n",
        "resources/core/config.lua": "Config = { v = 1 }",
        "resources/old/fxmanifest.lua": "fx_version 'cerulean'",
        "_sql/001_base.sql": BASE_SQL,
    }

    print("Admin : base complète v1.0.0 avec son SQL")
    up1 = upload("1.0.0", V1, changes=[{"type": "NEW", "text": "Première version"}], title="Lancement")
    check(up1["kind"] == "FULL" and [m["name"] for m in up1["migrations"]] == ["001_base.sql"], "v1.0.0 publiée, SQL rangé dans l'historique")

    print("Joueur : télécharge le ZIP sur le site, importe sql/install.sql, lance")
    download_zip("1.0.0", SRV)
    check(read("server.cfg").startswith("ensure oxmysql") and read("resources/core/main.lua") == "print('core v1')\n", "ZIP : base complète avec server.cfg")
    check(not (SRV / "_sql").exists() and (SRV / "sql/install.sql").exists(), "ZIP : sql/install.sql présent, pas de _sql/")
    check(json.loads(read(".fbm/state.json"))["version"] == "1.0.0", "ZIP : installation reconnue (v1.0.0)")
    mysql("fivem_e2e", stdin=read("sql/install.sql"))
    check(mysql("fivem_e2e", "SELECT name FROM users ORDER BY identifier") == "Admin; le chef\nL'ami", "install.sql importé : données intactes (; et '' dans les chaînes)")
    check(mysql("fivem_e2e", "SELECT CONCAT(version,'/',name) FROM fbm_migrations") == "1.0.0/001_base.sql", "registre fbm_migrations rempli par install.sql")
    (SRV / "server.cfg").write_text("ensure oxmysql\nensure fbm-updater\nensure core\nsv_hostname 'MON SERVEUR'\n")
    (SRV / "resources/core/config.lua").write_text("Config = { v = 1, perso = true }")

    print("Admin : PATCH v1.1.0 (fichiers modifiés seulement + SQL + suppression)")
    PATCH = {
        "resources/core/main.lua": "print('core v2')\n",
        "resources/core/config.lua": "Config = { v = 2 }",
        "resources/garage/fxmanifest.lua": "fx_version 'cerulean' -- garage",
        "_sql/002_garage.sql": "CREATE TABLE owned_vehicles (owner VARCHAR(60), plate VARCHAR(12) PRIMARY KEY);\nALTER TABLE users ADD COLUMN money INT NOT NULL DEFAULT 500;",
        "fbm-delete.txt": "resources/old\n",
    }
    up2 = upload("1.1.0", PATCH, "&mode=patch", changes=[{"type": "NEW", "text": "Garage"}, {"type": "FIX", "text": "Spawn corrigé"}], title="Garage")
    check(up2["kind"] == "PATCH" and up2["parent"] == "1.0.0" and up2["deleted"] == 1, "patch fusionné sur v1.0.0 (1 ressource supprimée)", json.dumps(up2))

    print("Joueur : console txAdmin")
    out = fx("cmd", "status", token=token, db="fivem_e2e")
    check("Installée : v1.0.0" in out and "Disponible : v1.1.0" in out, "fbm status : versions", out)
    check("v1.1.0 — Garage" in out and "Spawn corrigé" in out and "002_garage.sql" in out, "fbm status : patch notes du site (nouveautés + SQL)", out)
    check("SQL : 1 fichier(s) à exécuter (002_garage.sql)" in out, "fbm status : SQL en attente", out)
    out = fx("cmd", "update", token=token, db="fivem_e2e")
    check("SQL exécuté : 1 fichier(s)" in out and "Redémarrez le serveur" in out, "fbm update : SQL exécuté, fichiers prêts", out)
    check(mysql("fivem_e2e", "SELECT money FROM users WHERE identifier='license:1'") == "500", "base de données à jour (colonne money)")
    check(read("resources/core/main.lua") == "print('core v1')\n", "fichiers inchangés avant le redémarrage")
    out = fx("boot", token=token, db="fivem_e2e")
    check("Mise à jour appliquée : v1.0.0 → v1.1.0" in out, "redémarrage : mise à jour appliquée", out)
    check(read("resources/core/main.lua") == "print('core v2')\n" and read("resources/garage/fxmanifest.lua").endswith("garage"), "fichiers modifiés / ajoutés installés")
    check(not (SRV / "resources/old").exists(), "ressource retirée du patch supprimée (installation venue du ZIP)")
    check("MON SERVEUR" in read("server.cfg") and "perso" in read("resources/core/config.lua"), "server.cfg et config.lua du joueur conservés")
    out = fx("cmd", "update", token=token, db="fivem_e2e")
    check("Rien à faire" in out and "SQL à exécuter" not in out, "relancer : rien à faire, aucun SQL ré-exécuté", out)

    print("Interopérabilité avec le launcher Rust")
    rc, out = cli("status", token=token)
    check(rc == 0 and "Installé : v1.1.0" in out and "0 à écrire" in out, "le launcher relit l'état écrit par la ressource", out)

    print("Nouveau joueur : télécharge directement la base v1.1.0")
    download_zip("1.1.0", SRV2)
    check(read("resources/core/main.lua", SRV2) == "print('core v2')\n" and not (SRV2 / "resources/old").exists(), "ZIP v1.1.0 : base complète à jour")
    mysql("fivem_e2e2", stdin=read("sql/install.sql", SRV2))
    check(mysql("fivem_e2e2", "SELECT COUNT(*) FROM fbm_migrations") == "2" and mysql("fivem_e2e2", "SELECT money FROM users LIMIT 1") == "500", "install.sql v1.1.0 : tout le SQL (base + garage)")
    out = fx("cmd", "update", token=token, srv=SRV2, db="fivem_e2e2")
    check("Rien à faire" in out and "SQL" not in out.split("Recherche")[1], "prêt à lancer : ni fichier ni SQL à appliquer", out)

    print("Rollback, version précise, réparation")
    _, vs = http("GET", "/api/admin/versions", "tok-admin")
    v10 = next(v for v in vs["versions"] if v["version"] == "1.0.0")
    http("POST", f"/api/admin/versions/{v10['id']}/rollback", "tok-admin")
    out = fx("cmd", "update", token=token, db="fivem_e2e")
    check("le SQL des versions plus récentes n'est pas annulé" in out, "rollback : avertissement SQL", out)
    out = fx("boot", token=token)
    check("v1.1.0 → v1.0.0" in out and read("resources/core/main.lua") == "print('core v1')\n", "rollback appliqué", out)
    fx("cmd", "update", "1.1.0", token=token, db="fivem_e2e")
    fx("boot", token=token)
    check(read("resources/core/main.lua") == "print('core v2')\n", "« fbm update 1.1.0 » : version précise réinstallée")
    (SRV / "resources/core/main.lua").write_text("print('core v9')\n")
    out = fx("cmd", "repair", token=token, db="fivem_e2e")
    check("1 fichier(s) à télécharger" in out, "fbm repair détecte la corruption", out)
    fx("boot", token=token)
    check(read("resources/core/main.lua") == "print('core v2')\n", "réparé au redémarrage")

    print("Statistiques, maintenance, jeton révoqué")
    _, stats = http("GET", "/api/admin/stats", "tok-admin")
    row = next(v for v in stats["perVersion"] if v["version"] == "1.1.0")
    check(row["update"] >= 2 and row["repair"] >= 1 and row["zip"] >= 1, f"statistiques remontées au site (v1.1.0 : {row})")
    http("PUT", "/api/admin/settings", "tok-admin", body={"maintenance": {"enabled": True, "message": "Migration en cours"}})
    out = fx("cmd", "update", token=token, db="fivem_e2e")
    check("Échec : Migration en cours" in out, "maintenance : message du site affiché", out)
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
