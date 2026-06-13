-- CreateTable
CREATE TABLE "candles" (
    "market" TEXT NOT NULL,
    "resolution" INTEGER NOT NULL,
    "time" INTEGER NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "candles_pkey" PRIMARY KEY ("market","resolution","time")
);

-- CreateTable
CREATE TABLE "trades" (
    "owner" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL DEFAULT 'SOL-ETH',
    "side" TEXT NOT NULL,
    "notional" DOUBLE PRECISION NOT NULL,
    "collateral" DOUBLE PRECISION NOT NULL,
    "leverage" DOUBLE PRECISION NOT NULL,
    "entryRatio" DOUBLE PRECISION NOT NULL,
    "exitRatio" DOUBLE PRECISION NOT NULL,
    "realizedPnl" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL,
    "signature" TEXT,
    "closedTs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("owner","id")
);

-- CreateTable
CREATE TABLE "trade_events" (
    "id" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "symbol" TEXT NOT NULL DEFAULT 'SOL-ETH',
    "side" TEXT NOT NULL,
    "notional" DOUBLE PRECISION NOT NULL,
    "collateral" DOUBLE PRECISION NOT NULL,
    "leverage" DOUBLE PRECISION NOT NULL,
    "ratio" DOUBLE PRECISION NOT NULL,
    "realizedPnl" DOUBLE PRECISION,
    "signature" TEXT,
    "ts" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trade_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "traders" (
    "address" TEXT NOT NULL,
    "trades" INTEGER NOT NULL DEFAULT 0,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,
    "liquidations" INTEGER NOT NULL DEFAULT 0,
    "realizedPnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "volume" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "firstTradeTs" INTEGER,
    "lastTradeTs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "traders_pkey" PRIMARY KEY ("address")
);

-- CreateIndex
CREATE INDEX "trades_owner_closedTs_idx" ON "trades"("owner", "closedTs");

-- CreateIndex
CREATE INDEX "trades_closedTs_idx" ON "trades"("closedTs");

-- CreateIndex
CREATE INDEX "trade_events_owner_ts_idx" ON "trade_events"("owner", "ts");

-- CreateIndex
CREATE INDEX "trade_events_ts_idx" ON "trade_events"("ts");
