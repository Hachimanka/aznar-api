import type { NextFunction, Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import { config } from '../config.js'
import { HttpError, forbidden } from '../lib/http.js'
import { can, type Permission, type Role } from '../lib/permissions.js'

export type App = 'azone' | 'apay'

export type AuthContext = {
  userId: string
  name: string
  role: Role
  employeeId?: string
  app: App
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext
  }
}

export function signToken(ctx: AuthContext) {
  return jwt.sign({ name: ctx.name, role: ctx.role, employeeId: ctx.employeeId, app: ctx.app }, config.JWT_SECRET, {
    subject: ctx.userId,
    expiresIn: config.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
    issuer: 'aznar-api',
    audience: ctx.app,
  })
}

/** Require a valid token issued for this app. A token for AZONE never works on APAY routes and vice versa. */
export function requireAuth(app: App) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined
    if (!token) return next(new HttpError(401, 'Sign in required'))
    try {
      const p = jwt.verify(token, config.JWT_SECRET, { issuer: 'aznar-api', audience: app }) as jwt.JwtPayload
      req.auth = { userId: p.sub!, name: p.name, role: p.role, employeeId: p.employeeId, app }
      next()
    } catch {
      next(new HttpError(401, 'Your session has expired. Please sign in again.'))
    }
  }
}

export function requirePermission(permission: Permission) {
  return (req: Request, _res: Response, next: NextFunction) => (can(req.auth?.role, permission) ? next() : next(forbidden()))
}

/** Any of the given permissions is enough. */
export function requireAny(...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => (permissions.some((p) => can(req.auth?.role, p)) ? next() : next(forbidden()))
}

export function auth(req: Request) {
  if (!req.auth) throw new HttpError(401, 'Sign in required')
  return req.auth
}

/** AZONE routes act on the signed-in user's own employee record. */
export function employeeIdOf(req: Request) {
  const id = auth(req).employeeId
  if (!id) throw forbidden('Your account is not linked to an employee record')
  return id
}
