ALTER TABLE "topics" ADD COLUMN "is_p2p" boolean NOT NULL DEFAULT false;
ALTER TABLE "topics" ADD COLUMN "p2p_fallback_e2ee" boolean NOT NULL DEFAULT false;
ALTER TABLE "topics" ADD COLUMN "p2p_max_participants" integer;
