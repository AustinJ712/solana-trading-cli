-- Add migration script here
CREATE TABLE snipe_config (
    wallet VARCHAR NOT NULL,
    priv_key VARCHAR NOT NULL,
    snipe_amount_deprecated BIGINT NOT NULL,  -- Legacy field, no longer used
    snipe_amount_sol DECIMAL(20,9),  -- Amount in SOL (9 decimals)
    snipe_amount_usdc DECIMAL(20,6), -- Amount in USDC (6 decimals)
    token VARCHAR NOT NULL,
    jito_tip BIGINT NOT NULL,
    main_wallet VARCHAR NOT NULL,
    status INT NOT NULL,
    tx_hash VARCHAR,
    executed_at TIMESTAMP,
    PRIMARY KEY (wallet)
);
