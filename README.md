# Game Swap Migration API

TypeScript REST API for a game-swapping platform, built with Fastify and PostgreSQL, migrated from a PHP/MySQL graduate course project.

## Prerequisites

- Docker Desktop or Docker Engine
- Docker Compose
- Node.js 22.12+ and npm (for local development)

## Start with Docker

Copy `.env.example` to `.env` and fill in unique random values for
`POSTGRES_PASSWORD` and `SESSION_SECRET` before starting the services. Generate
a random value with:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Use separate values for `POSTGRES_PASSWORD` and `SESSION_SECRET`. The
`.env` file is ignored by Git; do not commit it.

```powershell
Copy-Item .env.example .env
```

From the project root, run:

```powershell
docker compose up --build -d
```

This starts PostgreSQL on `localhost:5433` and the API on `http://localhost:4000`.
Check the API:

```powershell
Invoke-RestMethod http://localhost:4000/
Invoke-RestMethod http://localhost:4000/health
```

The root endpoint lists the API routes. The health endpoint returns
`{"status":"ok"}`. You can also inspect service status and logs:

```powershell
docker compose ps
docker compose logs -f
```

PostgreSQL applies `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB` only
when initializing an empty data volume. If you already have a
`gameswap_pgdata` volume, changing `.env` does not change the credentials in
that existing database. Preserve existing data and update credentials
deliberately; do not remove the volume unless you intend to delete its data.

## Use the API

Send JSON requests to `http://localhost:4000`. The examples below use
PowerShell's `Invoke-RestMethod`; the same routes can be called from any HTTP
client.

### Endpoint implementation status

All listed routes are implemented. `Body` means a JSON request body; `Query`
means URL query parameters; `Path` means a value embedded in the URL. Fields
marked optional may be omitted. Protected routes require the
`gameswap_session` cookie created by login.

| Method | Route | Parameters | Behavior |
| --- | --- | --- | --- |
| `POST` | `/api/v1/users` | Body: `email`, `password`, `first_name`, `last_name`, `nickname`, `postal_code` (required); optional `phone` object | Register a user |
| `POST` | `/api/v1/auth/login` | Body: `email`, `password` (required) | Verify credentials and set a session cookie |
| `POST` | `/api/v1/auth/logout` | None | Clear the session cookie |
| `GET` | `/api/v1/users/me` | Cookie: `gameswap_session` | Return the signed-in user's profile |
| `PATCH` | `/api/v1/users/me` | Cookie; Body: one or more of `first_name`, `last_name`, `nickname`, `postal_code`, `phone` | Update the signed-in user's profile; set `phone` to `null` to remove it |
| `GET` | `/api/v1/dashboard` | Cookie | Return average rating, unaccepted and overdue proposals, and unrated accepted swaps |
| `POST` | `/api/v1/items` | Cookie; Body: `type`, `title`, `condition`, `email` (must match the signed-in user); `description` and type-specific fields as appropriate | Create an item; see [Create items](#3-create-items) |
| `GET` | `/api/v1/items/counts` | Query: `email` (required, valid email address) | Return item counts by type |
| `GET` | `/api/v1/items/mine` | Cookie | List the signed-in user's items |
| `GET` | `/api/v1/items/search` | Cookie; Query: optional `q` or `keyword`, `type`, `condition`, `postal_code` or `my_postal=true`, `miles` (0–10,000), `platform`, `limit` (1–100, default 20), `offset` (default 0) | Search and filter available listings by Haversine distance |
| `GET` | `/api/v1/items/:itemId` | Cookie; Path: positive integer `itemId` | Get item details, owner rating, and distance from the signed-in user |
| `PATCH` | `/api/v1/items/:itemId` | Cookie; Path: positive integer `itemId`; Body: at least one supported item field | Update an item owned by the signed-in user |
| `DELETE` | `/api/v1/items/:itemId` | Cookie; Path: positive integer `itemId` | Delete an item owned by the signed-in user |
| `POST` | `/api/v1/swaps` | Cookie; Body: positive integer `proposed_item_number`, `desired_item_number`, and `date_proposed` | Propose a swap using an item owned by the signed-in user |
| `PATCH` | `/api/v1/swaps/decision` | Cookie; Body: positive integer `proposed_item_number`, `desired_item_number`, and boolean `accepted` | Accept or reject a proposal received by the signed-in user |
| `PATCH` | `/api/v1/swaps/rate` | Cookie; Body: positive integer `proposed_item_number`, `desired_item_number`, `role` (`proposer` or `counterparty`), integer `rating` (0–5) | Submit the signed-in user's rating for an accepted swap |
| `GET` | `/api/v1/swaps/incoming` | Cookie; Query: optional `limit` (1–100, default 50), `offset` (default 0) | List incoming pending proposals with proposer rating and distance |
| `GET` | `/api/v1/swaps/ratings/pending` | Cookie; Query: optional `limit` (1–100, default 50), `offset` (default 0) | List accepted swaps the user has not rated |
| `GET` | `/api/v1/swaps/history` | Cookie; Query: optional `limit` (1–100, default 50), `offset` (default 0) | List the user's accepted and rejected swaps |

Item search accepts `q` (or its legacy-compatible alias `keyword`) to match
titles and descriptions. `miles` filters by distance from the signed-in user's
postal-code coordinates, while `postal_code` selects an exact postal code and
`my_postal=true` selects the signed-in user's postal code. Distances use the
Haversine formula and are returned in miles rounded to one decimal place.
Search excludes the signed-in user's own items and items involved in pending or
accepted swaps, matching the legacy search behavior. `type` must be one of
`boardGame`, `cardGame`, `jigsawPuzzle`, `computerGame`, or `videoGame`. Item
updates accept `title`, `condition`,
`description` (which can be set to `null`), and the applicable subtype fields:
`pieces` for a jigsaw puzzle, `platform` for a computer game, or `platform`
and/or `media` for a video game. An item cannot be changed into another type.
Deleting an item also deletes swaps that reference it, as configured by the
database foreign keys.

Login accepts `email` and `password`, returns the user's public profile, and
sets an HttpOnly session cookie. For example:

```powershell
$credentials = @{
  email = "user@example.com"
  password = "dev-only-password"
} | ConvertTo-Json

Invoke-RestMethod -Method Post `
  -Uri http://localhost:4000/api/v1/auth/login `
  -ContentType "application/json" `
  -Body $credentials `
  -SessionVariable gameSwapSession
```

Run this login request after registering the account; protected item and swap
operations use the resulting session.

Use `$gameSwapSession` as the `-WebSession` argument on subsequent
`Invoke-RestMethod` requests to send the cookie. Send a `POST` request to
`/api/v1/auth/logout` with that web session to clear it. Set a unique
`SESSION_SECRET` of at least 32 characters in `.env`; the API refuses to start
if it is missing or too short. Item ownership changes and swap operations that
act on behalf of a user require this session. Item creation includes an
`email` in its request body, which must match the signed-in user. Item counts
use an `email` query parameter.

### 1. Add required reference data

User creation requires a postal code already present in `addresses`. Add a
development address with:

```powershell
docker exec gameswap_postgres psql -U gameswap -d gameswap_db -c "INSERT INTO addresses (postal_code, city, state, latitude, longitude) VALUES ('12345', 'Testville', 'TS', 0, 0) ON CONFLICT (postal_code) DO NOTHING;"
```

Video-game items also require their platform to exist in `platforms`. For
example:

```powershell
docker exec gameswap_postgres psql -U gameswap -d gameswap_db -c "INSERT INTO platforms (platform) VALUES ('PlayStation 5') ON CONFLICT (platform) DO NOTHING;"
```

Other item types in the examples below do not need platform reference data.

### 2. Create users

`POST /api/v1/users` registers a user. The required fields are `email`,
`password`, `first_name`, `last_name`, `nickname`, and a five-digit
`postal_code` that exists in `addresses`.
Phone details are optional. When provided, `phone` must contain a `phone_number`
in `###-###-####` format and a `type` of `Home`, `Mobile`, or `Work`;
`shareable` defaults to `false`.

```json
{
  "phone": {
    "phone_number": "404-555-1212",
    "type": "Mobile",
    "shareable": true
  }
}
```

The profile response includes `phone` as either that object or `null`. A profile
update can replace the phone by supplying an object or remove it with `"phone":
null`. Phone number changes are unique across users.

If upgrading a database created before phone profile support, check for any
existing users with multiple phone rows before applying the corresponding
uniqueness constraint:

```sql
SELECT email, COUNT(*)
FROM phones
GROUP BY email
HAVING COUNT(*) > 1;

ALTER TABLE phones
ADD CONSTRAINT uq_phones_email UNIQUE (email);
```

```powershell
$user = @{
  email = "user@example.com"
  password = "dev-only-password"
  first_name = "Test"
  last_name = "User"
  nickname = "tester"
  postal_code = "12345"
} | ConvertTo-Json

Invoke-RestMethod -Method Post `
  -Uri http://localhost:4000/api/v1/users `
  -ContentType "application/json" `
  -Body $user
```

Create a second user as well to own the other item in the swap example:

```powershell
$otherUser = @{
  email = "other@example.com"
  password = "dev-only-password"
  first_name = "Other"
  last_name = "User"
  nickname = "other"
  postal_code = "12345"
} | ConvertTo-Json

Invoke-RestMethod -Method Post `
  -Uri http://localhost:4000/api/v1/users `
  -ContentType "application/json" `
  -Body $otherUser
```

Log in separately as the second user and keep a separate web session:

```powershell
$otherCredentials = @{
  email = "other@example.com"
  password = "dev-only-password"
} | ConvertTo-Json

Invoke-RestMethod -Method Post `
  -Uri http://localhost:4000/api/v1/auth/login `
  -ContentType "application/json" `
  -Body $otherCredentials `
  -SessionVariable otherGameSwapSession
```

Passwords are stored using scrypt hashes. Existing accounts whose
`password_hash` still contains a legacy plaintext password are upgraded to a
scrypt hash after their first successful login. Do not reuse passwords from
other accounts.

### 3. Create items

`POST /api/v1/items` accepts a `type` and common item fields. Valid conditions
are `Mint`, `Like New`, `Lightly Used`, `Moderately Used`, `Heavily Used`, and
`Damaged/Missing parts`.

Create one board game for each user:

```powershell
$item1 = @{
  type = "boardGame"
  title = "Example board game"
  condition = "Like New"
  description = "Complete, lightly played"
  email = "user@example.com"
} | ConvertTo-Json

$created1 = Invoke-RestMethod -Method Post `
  -Uri http://localhost:4000/api/v1/items `
  -ContentType "application/json" `
  -Body $item1 `
  -WebSession $gameSwapSession
$created1
```

```powershell
$item2 = @{
  type = "boardGame"
  title = "Another board game"
  condition = "Mint"
  email = "other@example.com"
} | ConvertTo-Json

$created2 = Invoke-RestMethod -Method Post `
  -Uri http://localhost:4000/api/v1/items `
  -ContentType "application/json" `
  -Body $item2 `
  -WebSession $otherGameSwapSession
$created2
```

Each successful response includes an `itemID`. Save both IDs for the swap
request. The type-specific fields are:

| `type` | Additional required fields |
| --- | --- |
| `boardGame` | None |
| `cardGame` | None |
| `jigsawPuzzle` | `pieces` (positive integer) |
| `computerGame` | `platform`: `Linux`, `macOS`, or `Windows` |
| `videoGame` | `media`: `optical disc`, `game card`, or `cartridge`; and `platform` (must exist in `platforms`) |

All item types require `title`, `condition`, and the owning user's `email`.
The request must include the session cookie of the account matching `email`.

### 4. Propose a swap

`POST /api/v1/swaps` requires both item IDs and `date_proposed` as a date
string. The logged-in proposer must own the proposed item; proposals are
created pending.

```powershell
$swap = @{
  proposed_item_number = $created1.itemID
  desired_item_number = $created2.itemID
  date_proposed = (Get-Date -Format "yyyy-MM-dd")
} | ConvertTo-Json

Invoke-RestMethod -Method Post `
  -Uri http://localhost:4000/api/v1/swaps `
  -ContentType "application/json" `
  -Body $swap `
  -WebSession $gameSwapSession
```

The response confirms the proposal and returns the item coordinates. Unknown
items return `404`; duplicate item combinations return `409 Conflict`.

### 5. Accept or reject a proposal

`PATCH /api/v1/swaps/decision` takes the same two item IDs and a boolean
`accepted` value. Only the owner of the desired item may make the decision, so
this request uses the recipient's session:

```powershell
$decision = @{
  proposed_item_number = $created1.itemID
  desired_item_number = $created2.itemID
  accepted = $true
} | ConvertTo-Json

Invoke-RestMethod -Method Patch `
  -Uri http://localhost:4000/api/v1/swaps/decision `
  -ContentType "application/json" `
  -Body $decision `
  -WebSession $otherGameSwapSession
```

Set `accepted` to `$false` to reject the proposal.

### 6. Rate an accepted swap

`PATCH /api/v1/swaps/rate` updates a rating for an accepted swap. `role` must
be `proposer` or `counterparty`, and `rating` must be an integer from 0 to 5.
The session must belong to the participant named by `role`:

```powershell
$rating = @{
  proposed_item_number = $created1.itemID
  desired_item_number = $created2.itemID
  role = "proposer"
  rating = 5
} | ConvertTo-Json

Invoke-RestMethod -Method Patch `
  -Uri http://localhost:4000/api/v1/swaps/rate `
  -ContentType "application/json" `
  -Body $rating `
  -WebSession $gameSwapSession
```

Call again with `role = "counterparty"` and
`-WebSession $otherGameSwapSession` to record the other rating. Ratings can
only be saved after the swap has been accepted.

## Local development

Install dependencies and start the API in watch mode:

```powershell
npm install
npm run dev
```

The API listens on port 4000. Ensure PostgreSQL is running and configure these
environment variables before starting the app:

```text
PGHOST=localhost
PGPORT=5433
PGUSER=gameswap
PGPASSWORD=<your local database password>
PGDATABASE=gameswap_db
SESSION_SECRET=<a unique random value of at least 32 characters>
```

The API does not provide default database credentials or a default session
secret. Set these values in your terminal before running `npm run dev` or
`npm start`.

To compile and run the built app:

```powershell
npm run build
npm start
```

`npm run build` compiles the TypeScript files in `src/` and writes the generated
JavaScript to `dist/`. Run it again after changing source files to regenerate
the compiled output.

## Tests

Run the Vitest suite with:

```powershell
npm test
```

The suite covers domain schema validation, session and password utilities, and
route behavior using Fastify injection with a mocked database. It does not
require Docker or a running PostgreSQL instance. Tests are located under
`test/`.

The PostgreSQL integration test creates a unique temporary schema, applies
`src/init.sql`, checks database constraints and cascade behavior, then drops
the schema. Run it against a disposable PostgreSQL database:

```powershell
$env:DATABASE_INTEGRATION_URL = "postgresql://user:password@localhost:5432/test_db"
npm run test:integration
```

The database user needs permission to create and drop schemas. Do not use a
production database for this test.

## Database and useful commands

The schema is in `src/init.sql`. Docker Compose mounts it into PostgreSQL for
initialization when the database volume is first created.

```powershell
# Stop services but keep database data
docker compose down

# Stop services and delete the database volume (this permanently deletes its data)
docker compose down -v

# Start again
docker compose up --build -d
```

If the schema was not applied on the first run because the database volume
already existed, recreate that volume with `docker compose down -v` and start
again. This deletes all data in the compose database.
