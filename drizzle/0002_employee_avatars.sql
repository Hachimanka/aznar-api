CREATE TABLE "employee_avatars" (
	"employee_id" uuid PRIMARY KEY NOT NULL,
	"data_url" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "employee_avatars" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "employee_avatars" ADD CONSTRAINT "employee_avatars_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;