#!/usr/bin/env python3
"""
Test bout-en-bout du launcher contre un VRAI serveur (Next.js + PostgreSQL + stockage local).

Prérequis : PostgreSQL avec une base vide `fbm_launcher_e2e` (droits pour l'utilisateur fbm) et
`cargo build --release -p fbm-core --bin fbm-cli` dans launcher/ (le build de web/ est fait au besoin).

    python3 launcher/e2e/run.py
"""
import hashlib, io, json, os, random, re, shutil, signal, subprocess, sys, tempfile, time, urllib.request, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WEB, CLI = ROOT / "web", ROOT / "launcher/target/release/fbm-cli"
PORT = 3301
BASE = f"http://localhost:{PORT}"
DB = os.environ.get("E2E_DATABASE_URL", "postgresql://fbm:fbm@localhost:5432/fbm_launcher_e2e")
STORE = tempfile.mkdtemp(prefix="fbm-e2e-store-")
WORK = Path(tempfile.mkdtemp(prefix="fbm-e2e-work-"))
INSTALL = WORK / "server"
ADMIN_ID = "999999999999999999"
passed = 0


def check(cond, label):
    global passed
    if not cond:
        print(f"  ✗ {label}")
        raise SystemExit(f"ÉCHEC : {label}")
    passed += 1
    print(f"  ✓ {label}")


def psql(sql):
    subprocess.run(["psql", DB, "-q", "-c", sql], check=True, capture_output=True)


def sha(b):
    return hashlib.sha256(b).hexdigest()


def http(method, path, cookie=None, body=None, raw=None, ctype=None):
    headers = {}
    data = None
    if cookie:
        headers["Cookie"] = f"fbm_session={cookie}"
        if method != "GET":
            headers["Origin"] = BASE
    if body is not None:
        data, headers["Content-Type"] = json.dumps(body).encode(), "application/json"
    if raw is not None:
        data, headers["Content-Type"] = raw, ctype or "application/zip"
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


def cli(*args, token, expect_ok=True):
    p = subprocess.run([str(CLI), "--api", BASE, "--token", token, "--dir", str(INSTALL), *args], capture_output=True, text=True)
    out = p.stdout + p.stderr.replace("\r", "\n")
    if expect_ok and p.returncode != 0:
        raise SystemExit(f"fbm-cli {' '.join(args)} a échoué :\n{out}")
    return p.returncode, out


# ── base de données + serveur ──────────────────────────────────────────────
env = {**os.environ, "DATABASE_URL": DB}
if not (WEB / ".next/BUILD_ID").exists():
    print("Build de production absent : npx next build …")
    subprocess.run(["npx", "next", "build"], cwd=WEB, env=env, check=True, capture_output=True)
subprocess.run(["npx", "prisma", "migrate", "deploy"], cwd=WEB, env=env, check=True, capture_output=True)
psql('TRUNCATE "AuditLog","Download","Change","Version","Session","LauncherToken","Announcement","Setting","MediaAsset","User" CASCADE')
server = subprocess.Popen(
    ["npx", "next", "start", "-p", str(PORT)], cwd=WEB, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True,
    env={**env, "NODE_ENV": "production", "APP_URL": BASE, "APP_SECRET": "e2e-launcher-secret-e2e-launcher-secret", "DISCORD_CLIENT_ID": "1",
         "DISCORD_CLIENT_SECRET": "x", "DISCORD_GUILD_ID": "2", "ADMIN_DISCORD_IDS": ADMIN_ID, "STORAGE_DRIVER": "local", "STORAGE_LOCAL_DIR": STORE,
         "MAX_UPLOAD_MB": "100"},
)
log_lines = []
try:
    for _ in range(60):
        try:
            urllib.request.urlopen(BASE + "/api/public/latest"); break
        except Exception:
            time.sleep(1)
    else:
        raise SystemExit("serveur non démarré")

    print("Préparation : utilisateurs et sessions")
    for key, did, in_guild in (("admin", ADMIN_ID, True), ("member", "100000000000000001", True)):
        psql(f"""INSERT INTO "User"(id,"discordId",username,"inGuild","lastLoginAt") VALUES ('u_{key}','{did}','{key}',{str(in_guild).lower()},now());
                 INSERT INTO "Session"(id,"tokenHash","userId","expiresAt") VALUES ('s_{key}','{sha(f"tok-{key}".encode())}','u_{key}',now()+interval '1 day');""")
    admin, member = "tok-admin", "tok-member"

    # ── v1.0.0 : ~300 petits fichiers + un gros fichier incompressible ──────
    rnd = random.Random(42)
    big = rnd.randbytes(4 * 1024 * 1024)
    v1 = {"server.cfg": "endpoint_add_tcp 30120\nsv_hostname 'Base'", "resources/big/assets.bin": big, "resources/core/config.lua": "Config = { debug = false }"}
    for i in range(300):
        v1[f"resources/res{i:03d}/fxmanifest.lua"] = f"fx_version 'cerulean'\n-- resource {i}"
        v1[f"resources/res{i:03d}/server.lua"] = f"print('res {i}')\n" * 20
    v1["resources/removed-in-1.1/old.lua"] = "-- sera supprimé en 1.1.0"
    st, up = http("POST", "/api/admin/versions/upload?version=1.0.0", admin, raw=make_zip(v1))
    check(st == 200 and up["fileCount"] == len(v1), f"upload v1.0.0 ({up.get('fileCount')} fichiers)")
    st, _ = http("POST", f"/api/admin/versions/{up['id']}/publish", admin, body={"notifyDiscord": False})
    check(st == 200, "publication v1.0.0")
    st, tok = http("POST", "/api/account/tokens", member, body={"name": "e2e"})
    token = tok["token"]
    check(st == 200 and token.startswith("fvl_"), "jeton launcher créé pour un membre")

    print("Installation initiale")
    _, out = cli("update", token=token)
    check("aucune" in out and "OK : v1.0.0" in out, "installation v1.0.0 via fbm-cli")
    check(sha((INSTALL / "resources/big/assets.bin").read_bytes()) == sha(big), "gros fichier identique (SHA-256)")
    check(all((INSTALL / p).read_bytes() == (c if isinstance(c, bytes) else c.encode()) for p, c in v1.items()), f"les {len(v1)} fichiers sont identiques à l'archive")
    check((INSTALL / ".fbm/state.json").exists() and not (INSTALL / ".fbm/txn.json").exists(), "état écrit, aucun résidu de transaction")
    _, out = cli("update", token=token)
    check("Déjà à jour" in out, "relancer = déjà à jour (aucun téléchargement)")

    print("Personnalisation par l'utilisateur")
    (INSTALL / "server.cfg").write_text("MA CONFIG PERSO")
    (INSTALL / "resources/core/config.lua").write_text("Config = { debug = true, monCle = 'secret' }")
    (INSTALL / "resources/mon-script").mkdir()
    (INSTALL / "resources/mon-script/perso.lua").write_text("-- à moi")
    (INSTALL / "notes.txt").write_text("notes")

    # ── v1.1.0 : 1 modifié, 1 ajouté, 1 supprimé, le gros fichier ne change pas ──
    v2 = dict(v1)
    v2["resources/res007/server.lua"] = "print('res 7 v2')\n"
    v2["resources/nouveau/fxmanifest.lua"] = "fx_version 'cerulean' -- nouveau"
    v2["server.cfg"] = "endpoint_add_tcp 30120\nsv_hostname 'Base v2'"          # protégé
    v2["resources/core/config.lua"] = "Config = { debug = false, nouveau = 1 }"   # protégé
    del v2["resources/removed-in-1.1/old.lua"]
    st, up2 = http("POST", "/api/admin/versions/upload?version=1.1.0", admin, raw=make_zip(v2))
    d = up2["diff"]
    check(st == 200 and d["added"] == 1 and d["modified"] == 3 and d["removed"] == 1, f"diff serveur v1.1.0 : +{d['added']} ~{d['modified']} −{d['removed']}")
    check(d["downloadSize"] < 2000, f"le serveur annonce {d['downloadSize']} octets à télécharger (au lieu de {up2['totalSize']})")
    http("POST", f"/api/admin/versions/{up2['id']}/publish", admin, body={"notifyDiscord": False})

    print("Mise à jour différentielle")
    _, out = cli("status", token=token)
    check("1 à supprimer" in out and "2 protégés conservés" in out, "plan : 1 suppression, 2 fichiers protégés conservés")
    _, out = cli("update", token=token)
    m = re.search(r"(\d+) écrits, (\d+) supprimés, (\d+) téléchargés \(([\d.]+) (o|Ko|Mo)\)", out)
    check(m and int(m[1]) == 2 and int(m[3]) == 2 and int(m[2]) == 1, f"seuls {m[3] if m else '?'} fichiers téléchargés (les 2 configs protégées modifiées sont ignorées), {m[2] if m else '?'} supprimé ({m[4] if m else '?'} {m[5] if m else ''})")
    check(m[5] in ("o", "Ko"), "quelques octets transférés au lieu de ~4 Mo (le gros fichier n'est pas retéléchargé)")
    check((INSTALL / "resources/res007/server.lua").read_text() == "print('res 7 v2')\n", "fichier modifié mis à jour")
    check((INSTALL / "resources/nouveau/fxmanifest.lua").exists(), "nouveau fichier installé")
    check(not (INSTALL / "resources/removed-in-1.1").exists(), "fichier obsolète supprimé (et son dossier vide)")
    check((INSTALL / "server.cfg").read_text() == "MA CONFIG PERSO", "server.cfg protégé : conservé")
    check("monCle" in (INSTALL / "resources/core/config.lua").read_text(), "config.lua protégé : conservé")
    check((INSTALL / "resources/mon-script/perso.lua").exists() and (INSTALL / "notes.txt").exists(), "fichiers de l'utilisateur intacts")

    print("Rollback côté admin")
    st, vs = http("GET", "/api/admin/versions", admin)
    v10 = next(v for v in vs["versions"] if v["version"] == "1.0.0")
    st, rb = http("POST", f"/api/admin/versions/{v10['id']}/rollback", admin)
    check(st == 200 and rb["rollback"] is True, "rollback vers v1.0.0")
    _, out = cli("update", token=token)
    check("OK : v1.0.0" in out, "le launcher revient à v1.0.0")
    check((INSTALL / "resources/res007/server.lua").read_text() == v1["resources/res007/server.lua"], "fichier modifié restauré à l'ancienne version")
    check((INSTALL / "resources/removed-in-1.1/old.lua").exists() and not (INSTALL / "resources/nouveau").exists(), "fichier supprimé réapparu, fichier ajouté retiré")
    check((INSTALL / "server.cfg").read_text() == "MA CONFIG PERSO", "config toujours protégée après rollback")

    print("Réparation")
    target = INSTALL / "resources/res100/server.lua"
    original = target.read_bytes()
    target.write_bytes(bytes(b ^ 1 if i == 3 else b for i, b in enumerate(original)))   # même taille, 1 octet altéré
    _, out = cli("update", token=token)
    check(target.read_bytes() != original, "(mise à jour rapide : ne détecte pas une corruption de même taille)")
    _, out = cli("repair", token=token)
    check(target.read_bytes() == original and "1 écrits" in out, "réparation : le fichier corrompu est restauré")
    (INSTALL / "resources/res200/fxmanifest.lua").unlink()
    cli("update", token=token)
    check((INSTALL / "resources/res200/fxmanifest.lua").exists(), "fichier supprimé par erreur : réinstallé")

    print("Sécurité & états d'erreur")
    st, _ = http("PUT", "/api/admin/settings", admin, body={"maintenance": {"enabled": True, "message": "Migration en cours"}})
    rc, out = cli("status", token=token, expect_ok=False)
    check(rc != 0 and "Migration en cours" in out, "maintenance : le launcher affiche le message et s'arrête")
    http("PUT", "/api/admin/settings", admin, body={"maintenance": {"enabled": False, "message": ""}})
    http("DELETE", f"/api/account/tokens/{tok['id']}", member)
    rc, out = cli("status", token=token, expect_ok=False)
    check(rc != 0, "jeton révoqué : accès refusé")
    # interruption simulée : journal « committing » laissé par un crash
    (INSTALL / ".fbm/backup/t9/resources/res001").mkdir(parents=True)
    original = (INSTALL / "resources/res001/server.lua").read_bytes()
    (INSTALL / ".fbm/backup/t9/resources/res001/server.lua").write_bytes(original)
    (INSTALL / "resources/res001/server.lua").write_text("ECRIT A MOITIE")
    (INSTALL / ".fbm/txn.json").write_text(json.dumps({"id": "t9", "committing": True, "ops": [{"path": "resources/res001/server.lua", "write": True, "had_original": True}]}))
    _, out = cli("recover", token="x", expect_ok=True)
    check("restaurée" in out and (INSTALL / "resources/res001/server.lua").read_bytes() == original, "reprise après crash : installation restaurée")

    # le serveur n'a eu aucune erreur 500
    print(f"\n{passed} vérifications OK")
finally:
    try:
        os.killpg(os.getpgid(server.pid), signal.SIGTERM)
    except Exception:
        pass
    shutil.rmtree(STORE, ignore_errors=True)
    shutil.rmtree(WORK, ignore_errors=True)
