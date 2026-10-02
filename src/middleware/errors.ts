import type { NextFunction, Request, Response } from 'express'
import mongoose from 'mongoose'
import { HttpError } from '../lib/http.js'

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ message: 'Not found' })
}

/** Never leak stack traces or driver errors to the browser. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) return res.status(err.status).json({ message: err.message })
  if (err instanceof mongoose.Error.ValidationError) return res.status(400).json({ message: err.message })
  if (typeof err === 'object' && err && 'code' in err && (err as { code: number }).code === 11000) {
    return res.status(409).json({ message: 'A record with the same unique value already exists' })
  }
  if (err instanceof SyntaxError && 'body' in err) return res.status(400).json({ message: 'Malformed JSON body' })
  console.error(err)
  res.status(500).json({ message: 'Something went wrong. Please try again.' })
}
