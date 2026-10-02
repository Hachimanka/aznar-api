/** Mirrors apay/src/lib/permissions.ts — the API is the authority, the UI only hides buttons. */

export type StaffRole = 'hr' | 'payroll_admin' | 'finance' | 'management'
export type Role = StaffRole | 'employee'

export const staffRoles: StaffRole[] = ['hr', 'payroll_admin', 'finance', 'management']

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

export const rolePermissions: Record<StaffRole, Permission[]> = {
  payroll_admin: [
    'employees.manage',
    'attendance.manage',
    'payroll.process',
    'payroll.release',
    'adjustments.manage',
    'overtime.decide',
    'reports.view',
    'settings.manage',
  ],
  hr: ['employees.manage', 'attendance.manage', 'overtime.decide', 'announcements.manage', 'reports.view'],
  finance: ['payroll.approve', 'payroll.release', 'reports.view'],
  management: ['payroll.approve', 'reports.view'],
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
