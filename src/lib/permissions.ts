/** Mirrors apay/src/lib/permissions.ts — the API is the authority, the UI only hides buttons. */

/** Account roles stored in the users table. payroll_admin/finance/management are legacy: they can no longer use APAY. */
export type StaffRole = 'hr' | 'payroll_admin' | 'finance' | 'management'
export type Role = StaffRole | 'employee'

/** APAY is run by the HR department alone — only HR accounts may sign in or call /apay. */
export const staffRoles: StaffRole[] = ['hr']

export type Permission =
  | 'employees.manage'
  | 'attendance.manage'
  | 'payroll.process'
  | 'payroll.approve'
  | 'payroll.release'
  | 'adjustments.manage'
  | 'overtime.decide'
  | 'reports.view'
  | 'announcements.manage'
  | 'settings.manage'

const allPermissions: Permission[] = [
  'employees.manage',
  'attendance.manage',
  'payroll.process',
  'payroll.approve',
  'payroll.release',
  'adjustments.manage',
  'overtime.decide',
  'reports.view',
  'announcements.manage',
  'settings.manage',
]

export const rolePermissions: Record<StaffRole, Permission[]> = {
  hr: allPermissions,
  payroll_admin: [],
  finance: [],
  management: [],
}

export const roleLabels: Record<StaffRole, string> = {
  payroll_admin: 'Payroll Admin',
  hr: 'HR',
  finance: 'Finance',
  management: 'Management',
}

export function can(role: Role | undefined, permission: Permission) {
  return !!role && role !== 'employee' && rolePermissions[role].includes(permission)
}
