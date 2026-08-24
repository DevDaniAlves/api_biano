import bcrypt from "bcryptjs";
import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config.js";
import { prisma } from "../db.js";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: "admin" | "seller";
  seeAllMessages?: boolean;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export async function userCanSeeAllMessages(userId: string, role?: string) {
  if (role === "admin") return true;
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, seeAllMessages: true },
  });
  return u?.role === "admin" || Boolean(u?.seeAllMessages);
}

function signToken(user: AuthUser) {
  return jwt.sign(user, env.JWT_SECRET, { expiresIn: "7d" });
}

export function authRequired(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Não autenticado" });
    return;
  }
  try {
    req.user = jwt.verify(header.slice(7), env.JWT_SECRET) as AuthUser;
    next();
  } catch {
    res.status(401).json({ error: "Token inválido" });
  }
}

/** Usar após authRequired. */
export function adminRequired(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== "admin") {
    res.status(403).json({ error: "Somente admin" });
    return;
  }
  next();
}

export async function login(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user || !user.active) return null;
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return null;
  const payload: AuthUser = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    seeAllMessages: Boolean(user.seeAllMessages),
  };
  return { user: payload, token: signToken(payload) };
}

export async function changePassword(opts: {
  userId: string;
  currentPassword: string;
  newPassword: string;
}) {
  const next = opts.newPassword.trim();
  if (next.length < 6) {
    throw new Error("A nova senha deve ter pelo menos 6 caracteres");
  }
  const user = await prisma.user.findUnique({ where: { id: opts.userId } });
  if (!user?.active) throw new Error("Usuário não encontrado");
  const ok = await bcrypt.compare(opts.currentPassword, user.passwordHash);
  if (!ok) throw new Error("Senha atual incorreta");
  const same = await bcrypt.compare(next, user.passwordHash);
  if (same) throw new Error("A nova senha deve ser diferente da atual");
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(next, 10) },
  });
}

export async function createUser(data: {
  name: string;
  email: string;
  password: string;
  role?: "admin" | "seller";
  seeAllMessages?: boolean;
}) {
  const passwordHash = await bcrypt.hash(data.password, 10);
  return prisma.user.create({
    data: {
      name: data.name.trim(),
      email: data.email.toLowerCase(),
      passwordHash,
      role: data.role ?? "seller",
      seeAllMessages: Boolean(data.seeAllMessages),
    },
  });
}
