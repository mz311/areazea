import type { Role } from "@prisma/client";

export const ROLES: Role[] = ["MEMBER", "VIP", "DEVELOPER", "ADMIN"];
const RANK: Record<Role, number> = { MEMBER: 1, VIP: 2, DEVELOPER: 3, ADMIN: 4 };

export const ROLE_LABEL: Record<Role, string> = {
  MEMBER: "Membre",
  VIP: "VIP",
  DEVELOPER: "Développeur",
  ADMIN: "Administrateur",
};

export const hasRole = (role: Role, min: Role) => RANK[role] >= RANK[min];
export const effectiveRole = (u: { role: Role; roleOverride: Role | null }): Role => u.roleOverride ?? u.role;
export const maxRole = (a: Role, b: Role): Role => (RANK[a] >= RANK[b] ? a : b);

type AccessUser = { role: Role; roleOverride: Role | null; inGuild: boolean; banned: boolean };

/** Un utilisateur peut télécharger s'il est dans le serveur, non banni, et a le rôle minimum de la version. */
export function canDownload(user: AccessUser, version: { minRole: Role }): boolean {
  if (user.banned || !user.inGuild) return false;
  return hasRole(effectiveRole(user), version.minRole);
}
