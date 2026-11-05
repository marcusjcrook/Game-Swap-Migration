CREATE TYPE game_condition AS ENUM ('Mint', 'Like New', 'Lightly Used', 'Moderately Used', 'Heavily Used', 'Damaged/Missing parts');
CREATE TYPE pc_platform AS ENUM ('Linux', 'macOS', 'Windows');
CREATE TYPE video_media AS ENUM ('optical disc', 'game card', 'cartridge');
CREATE TYPE phone_type AS ENUM ('Home', 'Mobile', 'Work');

CREATE TABLE addresses (
    postal_code CHAR(5) NOT NULL,
    city VARCHAR(35) NOT NULL,
    state CHAR(2) NOT NULL,
    latitude DECIMAL(12, 6) NOT NULL,
    longitude DECIMAL(12, 6) NOT NULL,
    PRIMARY KEY (postal_code)
);

CREATE TABLE platforms (
    platform VARCHAR(50) NOT NULL,
    PRIMARY KEY (platform)
);

CREATE TABLE users (
    email VARCHAR(255) NOT NULL,
    password_hash TEXT NOT NULL, -- Renamed from 'password' to cleanly map to your query string
    first_name VARCHAR(50) NOT NULL,
    last_name VARCHAR(50) NOT NULL,
    nickname VARCHAR(50) NOT NULL,
    postal_code CHAR(5) NOT NULL,
    PRIMARY KEY (email),
    CONSTRAINT fk_users_postal_code_addresses_postal_code 
        FOREIGN KEY (postal_code) REFERENCES addresses(postal_code)
);

CREATE TABLE phones (
    phone_number VARCHAR(12) NOT NULL,
    type phone_type NOT NULL,
    shareable BOOLEAN NOT NULL DEFAULT FALSE,
    email VARCHAR(255) NOT NULL,
    PRIMARY KEY (phone_number),
    CONSTRAINT uq_phones_email UNIQUE (email),
    CONSTRAINT fk_phones_email_users_email 
        FOREIGN KEY (email) REFERENCES users(email) ON DELETE CASCADE
);

CREATE TABLE items (
    item_id SERIAL, -- Converted from AUTO_INCREMENT to PostgreSQL native SERIAL
    title VARCHAR(250) NOT NULL,
    condition game_condition NOT NULL,
    description VARCHAR(250),
    email VARCHAR(255) NOT NULL,
    PRIMARY KEY (item_id),
    CONSTRAINT fk_items_email_users_email 
        FOREIGN KEY (email) REFERENCES users(email)
);

CREATE TABLE board_games (
    item_id INT NOT NULL,
    PRIMARY KEY (item_id),
    CONSTRAINT fk_board_games_item_id_items_item_id 
        FOREIGN KEY (item_id) REFERENCES items(item_id) ON DELETE CASCADE
);

CREATE TABLE card_games (
    item_id INT NOT NULL,
    PRIMARY KEY (item_id),
    CONSTRAINT fk_card_games_item_id_items_item_id 
        FOREIGN KEY (item_id) REFERENCES items(item_id) ON DELETE CASCADE
);

CREATE TABLE jigsaw_puzzles (
    item_id INT NOT NULL,
    pieces INT NOT NULL CHECK (pieces > 0), -- Strict boundary check mapping to z.number().positive()
    PRIMARY KEY (item_id),
    CONSTRAINT fk_jigsaw_puzzles_item_id_items_item_id 
        FOREIGN KEY (item_id) REFERENCES items(item_id) ON DELETE CASCADE
);

CREATE TABLE computer_games (
    item_id INT NOT NULL,
    platform pc_platform NOT NULL,
    PRIMARY KEY (item_id),
    CONSTRAINT fk_computer_games_item_id_items_item_id 
        FOREIGN KEY (item_id) REFERENCES items(item_id) ON DELETE CASCADE
);

CREATE TABLE video_games (
    item_id INT NOT NULL,
    media video_media NOT NULL,
    platform VARCHAR(50) NOT NULL,
    PRIMARY KEY (item_id),
    CONSTRAINT fk_video_games_item_id_items_item_id 
        FOREIGN KEY (item_id) REFERENCES items(item_id) ON DELETE CASCADE,
    CONSTRAINT fk_video_games_platform_platforms_platform 
        FOREIGN KEY (platform) REFERENCES platforms(platform)
);

CREATE TABLE swaps (
    proposed_item_number INT NOT NULL,
    desired_item_number INT NOT NULL,
    accepted BOOLEAN,
    date_proposed DATE NOT NULL DEFAULT CURRENT_DATE,
    date_accepted_rejected DATE,
    proposer_rating INT CHECK (proposer_rating >= 0 AND proposer_rating <= 5), -- Bound checking
    counterparty_rating INT CHECK (counterparty_rating >= 0 AND counterparty_rating <= 5),
    PRIMARY KEY (proposed_item_number, desired_item_number),
    CONSTRAINT fk_swaps_proposed_item_items_item_id 
        FOREIGN KEY (proposed_item_number) REFERENCES items(item_id) ON DELETE CASCADE,
    CONSTRAINT fk_swaps_desired_item_items_item_id 
        FOREIGN KEY (desired_item_number) REFERENCES items(item_id) ON DELETE CASCADE
);
