CREATE TABLE "policy_drafts" (
	"draft_id" text PRIMARY KEY NOT NULL,
	"party" text NOT NULL,
	"fields" jsonb NOT NULL,
	"source" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seal_requests" (
	"seal_id" text PRIMARY KEY NOT NULL,
	"draft_id" text NOT NULL,
	"treasurer" text NOT NULL,
	"seal_request_cid" text,
	"governance_proposal_cid" text,
	"state" text NOT NULL,
	"confirmations" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"base_version" integer DEFAULT 0 NOT NULL,
	"mandate_version" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cycle_runs" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "cycle_runs" ADD COLUMN "trigger" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "cycle_runs" ADD COLUMN "trigger_detail" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "cycle_runs" ADD COLUMN "total" text;--> statement-breakpoint
ALTER TABLE "cycle_runs" ADD COLUMN "record_date" text;--> statement-breakpoint
ALTER TABLE "cycle_runs" ADD COLUMN "executes_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cycle_runs" ADD COLUMN "held" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "cycle_runs" ADD COLUMN "funds_shortfall" jsonb;--> statement-breakpoint
CREATE INDEX "policy_drafts_party_idx" ON "policy_drafts" USING btree ("party","updated_at");--> statement-breakpoint
CREATE INDEX "seal_requests_state_idx" ON "seal_requests" USING btree ("state");