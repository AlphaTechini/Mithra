ALTER TABLE "agent_events" ADD COLUMN "org_treasury" text;--> statement-breakpoint
CREATE INDEX "agent_events_treasury_cycle_idx" ON "agent_events" USING btree ("org_treasury","cycle_id","id");
--> statement-breakpoint
-- Timeline events written before this column existed belong to the only treasury that has a run of that cycle.
UPDATE "agent_events" AS e SET "org_treasury" = r."org_treasury"
FROM (
	SELECT "cycle_id", min("org_treasury") AS "org_treasury"
	FROM "cycle_runs"
	GROUP BY "cycle_id"
	HAVING count(DISTINCT "org_treasury") = 1
) AS r
WHERE e."kind" = 'timeline' AND e."org_treasury" IS NULL AND e."cycle_id" = r."cycle_id";
