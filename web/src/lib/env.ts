import { z } from "zod";

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  /** Secret >= 32 caractères : signe les liens de téléchargement locaux et les cookies d'état OAuth. */
  APP_SECRET: z.string().min(32, "APP_SECRET doit faire au moins 32 caractères"),

  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_CLIENT_SECRET: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
  DISCORD_BOT_TOKEN: z.string().optional(),
  DISCORD_INVITE_URL: z.string().url().optional(),
  DISCORD_WEBHOOK_URL: z.string().url().optional(),
  DISCORD_MAINTENANCE_WEBHOOK_URL: z.string().url().optional(),
  /** Salon staff : annonces des versions réservées (VIP / dev / bêta). */
  DISCORD_PRIVATE_WEBHOOK_URL: z.string().url().optional(),
  /** Rôle à mentionner dans les annonces de mise à jour (optionnel). */
  DISCORD_NOTIFY_ROLE_ID: z.string().optional(),
  DISCORD_ROLE_MEMBER_IDS: csv,
  DISCORD_ROLE_VIP_IDS: csv,
  DISCORD_ROLE_DEVELOPER_IDS: csv,
  DISCORD_ROLE_ADMIN_IDS: csv,
  /** Comptes Discord toujours administrateurs (amorçage). */
  ADMIN_DISCORD_IDS: csv,

  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default("./storage-data"),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z
    .string()
    .optional()
    .transform((v) => v === "true"),

  DOWNLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).default(2048),
  MAX_ARCHIVE_FILES: z.coerce.number().int().min(1).default(50000),
  MAX_FILE_MB: z.coerce.number().int().min(1).default(512),
  MAX_UNCOMPRESSED_MB: z.coerce.number().int().min(1).default(8192),
  MAX_COMPRESSION_RATIO: z.coerce.number().min(1).default(200),
  BLOCKED_EXTENSIONS: z
    .string()
    .default(".exe,.bat,.cmd,.com,.scr,.msi,.ps1,.vbs,.vbe,.js.map,.lnk,.jar,.sh"),

  LAUNCHER_DOWNLOAD_URL: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
      throw new Error(`Configuration invalide (.env) :\n${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** Pour les tests. */
export function resetEnvCache() {
  cached = undefined;
}

export const isProd = () => process.env.NODE_ENV === "production";
