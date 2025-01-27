-- Add migration script here
CREATE TABLE snipe_config (
    wallet VARCHAR NOT NULL,
    priv_key VARCHAR NOT NULL,
    snipe_amount BIGINT NOT NULL,
    token VARCHAR NOT NULL,
    jito_tip BIGINT NOT NULL,
    main_wallet VARCHAR NOT NULL,
    status INT NOT NULL,
    tx_hash VARCHAR,
    executed_at TIMESTAMP,
    PRIMARY KEY (wallet)
);
