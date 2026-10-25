/**
 * Données de démonstration (développement uniquement) : crée un administrateur local avec une session,
 * importe 2 versions via l'API et publie la dernière.
 *   npm run demo:seed            (le serveur doit tourner sur APP_URL)
 * Affiche le cookie à coller dans votre navigateur pour vous connecter sans passer par Discord.
 */
import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import yazl from "yazl";

const APP_URL = process.env.APP_URL ?? "http://localhost:3000";
if (process.env.NODE_ENV === "production") throw new Error("Refusé en production");

const prisma = new PrismaClient();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function zip(files: Record<string, string>) {
  const file = path.join(tmpdir(), `demo-${randomBytes(4).toString("hex")}.zip`);
  const z = new yazl.ZipFile();
  for (const [p, c] of Object.entries(files)) z.addBuffer(Buffer.from(c), p);
  z.end();
  await new Promise<void>((r) => z.outputStream.pipe(createWriteStream(file)).on("close", () => r()));
  return readFileSync(file);
}

async function main() {
  const adminId = (process.env.ADMIN_DISCORD_IDS ?? "999999999999999999").split(",")[0];
  const user = await prisma.user.upsert({
    where: { discordId: adminId },
    create: { discordId: adminId, username: "demo-admin", globalName: "Demo Admin", inGuild: true },
    update: { inGuild: true },
  });
  const token = randomBytes(24).toString("base64url");
  await prisma.session.create({ data: { tokenHash: sha(token), userId: user.id, expiresAt: new Date(Date.now() + 86400_000) } });
  const headers = { Cookie: `fbm_session=${token}`, Origin: APP_URL };

  const post = async (url: string, body: BodyInit, type: string) => {
    const r = await fetch(APP_URL + url, { method: "POST", headers: { ...headers, "Content-Type": type }, body });
    const j = await r.json();
    if (!r.ok) throw new Error(`${url}: ${j.error}`);
    return j;
  };

  for (const [version, extra] of [["1.0.0", {}], ["1.1.0", { "resources/garage/fxmanifest.lua": "fx_version 'cerulean'" }]] as const) {
    if (await prisma.version.findUnique({ where: { version } })) continue;
    const buf = await zip({
      "server.cfg": "endpoint_add_tcp \"0.0.0.0:30120\"",
      "resources/core/fxmanifest.lua": `fx_version 'cerulean' -- ${version}`,
      "resources/core/config.lua": "Config = {}",
      ...extra,
    });
    const up = await post(`/api/admin/versions/upload?version=${version}`, new Uint8Array(buf), "application/zip");
    const put = await fetch(`${APP_URL}/api/admin/versions/${up.id}`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: version === "1.0.0" ? "Lancement de la base" : "Garage, économie & performances",
        summary: version === "1.0.0" ? "Première version publique de la base." : "Une grosse mise à jour de contenu et de stabilité.",
        changes: [
          { type: "NEW", text: "Nouveau système de garage avec stockage des véhicules" },
          { type: "NEW", text: "Interface d'inventaire repensée" },
          { type: "FIX", text: "Correction du spawn des joueurs après reconnexion" },
          { type: "IMPROVEMENT", text: "Temps de chargement réduit de 40 %" },
        ],
      }),
    });
    if (!put.ok) throw new Error("PUT changelog");
    await post(`/api/admin/versions/${up.id}/publish`, JSON.stringify({ notifyDiscord: false }), "application/json");
    console.log(`v${version} publiée`);
  }
  await prisma.announcement.create({ data: { kind: "NEWS", title: "Bienvenue sur la plateforme !", body: "Connectez-vous avec Discord pour télécharger la base et installer le launcher.", pinned: true } }).catch(() => undefined);
  console.log(`\nCookie admin de démo (DevTools → Application → Cookies) :\n  fbm_session=${token}\n`);
}

main().finally(() => prisma.$disconnect());
