# Mike (Azure fork)

Modified version of [Mike](https://github.com/willchen96/mike) that drops the
Supabase, Cloudflare R2, and OpenRouter dependencies in favour of a
Microsoft Azure stack:

- **Azure SQL Server** for the database (self-hosted SQL Server for local dev)
- **JWT + bcrypt** auth, replacing Supabase Auth
- **Azure OpenAI** for LLM (Anthropic Claude and Google Gemini remain
  available as optional providers)
- **Azure Blob** or a mounted **Azure Files** share for document storage
  (local filesystem for dev), replacing Cloudflare R2

See [NOTICE.md](./NOTICE.md) for the AGPL-3.0 attribution and a full list
of modifications.

## Contents

- `frontend/` — Next.js 16 application
- `backend/` — Express API, document processing, migrations
- `backend/migrations/000_one_shot_schema.sql` — T-SQL schema for a fresh database
- `docker-compose.yml` — local SQL Server (Azure SQL Edge) for development

## Local setup

### Prerequisites

- Node 20+
- Docker Desktop (for local SQL Server)
- LibreOffice on `PATH` (only required for DOC/DOCX → PDF conversion)
- An Azure OpenAI deployment (or Anthropic / Gemini API keys)

### 1. Spin up local SQL Server

```bash
docker compose up -d
```

This starts an Azure SQL Edge container at `localhost:1433`
(`sa` / `Local-Dev-1234`). To apply the schema, connect with SSMS (or any
SQL client), `CREATE DATABASE mike;`, switch to it, and execute
[`backend/migrations/000_one_shot_schema.sql`](backend/migrations/000_one_shot_schema.sql).

### 2. Install dependencies

```bash
cd backend && npm install
cd ../frontend && npm install
```

### 3. Configure environment

```bash
cp backend/.env.example backend/.env
cp frontend/.env.local.example frontend/.env.local
```

Fill in `backend/.env`:

- `DATABASE_URL` — defaults match the local Docker container above
- `JWT_SECRET` — any 32+ character random string
- `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_API_VERSION`

`STORAGE_BACKEND` defaults to `local` and writes documents under
`backend/uploads/` — no extra setup needed.

### 4. Run

```bash
# terminal 1
cd backend && npm run dev
# terminal 2
cd frontend && npm run dev
```

Open `http://localhost:3000`, sign up, and try a chat.

## Authentication

Auth is handled entirely by the Express backend — no Supabase, no third-party
identity provider.

- **Users table** (`dbo.users`): email + bcrypt password hash, created by
  the schema in `backend/migrations/000_one_shot_schema.sql`.
- **Signup** (`POST /auth/signup`) — validates email, hashes the password
  with bcrypt (cost 10), inserts into `dbo.users`, bootstraps a row in
  `dbo.user_profiles`, and returns a JWT.
- **Login** (`POST /auth/login`) — looks up the user by email, verifies the
  password hash, returns a JWT.
- **Session** — JWT is signed with `JWT_SECRET` (HMAC-SHA256), TTL 30 days,
  contains `{ sub: userId, email }`. The frontend stores it in localStorage
  under the key `mike_session` and sends it as `Authorization: Bearer <jwt>`
  on every API call.
- **Middleware** (`backend/src/middleware/auth.ts`) — verifies the JWT and
  attaches `userId` / `userEmail` to `res.locals` for downstream handlers.

There is no out-of-the-box SSO or password-reset flow; this is intended for
internal deployment where users are provisioned by the operator. To add
either, swap or extend `backend/src/routes/auth.ts`.

## Production deploy on Azure

- Backend: Web App for Containers (image from `backend/Dockerfile`), VNET
  integrated to reach Azure SQL / OpenAI private endpoints
- Frontend: Web App for Containers (image from `frontend/Dockerfile`)
- Document storage: Azure Files share mounted at `/mnt/docs` on the
  backend Web App with `STORAGE_BACKEND=local` and
  `LOCAL_STORAGE_DIR=/mnt/docs` — or use `STORAGE_BACKEND=azure` against
  Azure Blob Storage with `AZURE_STORAGE_CONNECTION_STRING`

## License

AGPL-3.0-only. See [LICENSE](./LICENSE) and [NOTICE.md](./NOTICE.md).
