CREATE TABLE "mainnet_wallets" (
	"holder_party" text PRIMARY KEY NOT NULL,
	"mainnet_party" text NOT NULL,
	"public_key" text NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL
);
