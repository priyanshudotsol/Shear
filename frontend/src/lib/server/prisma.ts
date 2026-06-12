// SERVER-ONLY Prisma client singleton. Reused across dev hot-reloads so we don't exhaust the
// Postgres connection pool with a new client on every recompile.
import { PrismaClient } from "@prisma/client";

const g = globalThis as unknown as { __shearPrisma?: PrismaClient };

export const prisma = g.__shearPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") g.__shearPrisma = prisma;
