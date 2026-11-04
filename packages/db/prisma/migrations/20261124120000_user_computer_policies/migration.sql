-- Additive: the previous release never reads this table. A missing row still means "ask", so
-- every bot keeps exactly the approval behavior it had before this migration.
CREATE TABLE "user_computer_policies" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "deviceKey" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_computer_policies_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_computer_policies_spaceId_fkey" FOREIGN KEY ("spaceId")
      REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "user_computer_policies_userId_fkey" FOREIGN KEY ("userId")
      REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "user_computer_policies_botId_fkey" FOREIGN KEY ("botId")
      REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "user_computer_policies_botId_deviceKey_key"
  ON "user_computer_policies"("botId", "deviceKey");
CREATE INDEX "user_computer_policies_spaceId_userId_idx"
  ON "user_computer_policies"("spaceId", "userId");

-- Tenants read and write only their own rows; every query also filters by botId.
ALTER TABLE "user_computer_policies" ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_computer_policies_tenant ON "user_computer_policies"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), '')
    AND "spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY user_computer_policies_system ON "user_computer_policies"
  USING (current_setting('app.rls_bypass', true) = 'on');
