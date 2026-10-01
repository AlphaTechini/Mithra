CREATE TABLE "activity_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_party" text NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"cycle_id" text,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"party_id" text NOT NULL,
	"role" text NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cycle_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_treasury" text NOT NULL,
	"cycle_id" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "cycle_runs_org_cycle_unique" UNIQUE("org_treasury","cycle_id")
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"code" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"party_id" text,
	"display_name" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"party_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tx_refs" (
	"contract_id" text NOT NULL,
	"update_id" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tx_refs_contract_id_kind_pk" PRIMARY KEY("contract_id","kind")
);
--> statement-breakpoint
CREATE INDEX "activity_log_created_idx" ON "activity_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "agent_events_cycle_idx" ON "agent_events" USING btree ("cycle_id","id");--> statement-breakpoint
CREATE INDEX "chat_messages_party_idx" ON "chat_messages" USING btree ("party_id","id");--> statement-breakpoint
CREATE INDEX "tx_refs_update_idx" ON "tx_refs" USING btree ("update_id");