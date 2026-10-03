CREATE TABLE "attendance_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"days_present" real NOT NULL,
	"absent_days" real NOT NULL,
	"late_minutes" integer NOT NULL,
	"paid_leave_days" real NOT NULL,
	"unpaid_leave_days" real NOT NULL,
	"source" text NOT NULL,
	"updated_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attendance_overrides" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "attendance_overrides" ADD CONSTRAINT "attendance_overrides_period_id_payroll_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."payroll_periods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_overrides" ADD CONSTRAINT "attendance_overrides_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_overrides" ADD CONSTRAINT "attendance_overrides_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_overrides_period_employee_uq" ON "attendance_overrides" USING btree ("period_id","employee_id");