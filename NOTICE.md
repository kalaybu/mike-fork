# NOTICE

This is a modified version of [Mike](https://github.com/willchen96/mike),
licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).

- Original work © the original Mike authors.
- Modifications © 2026 the contributors of this repository.

Substantive modifications from upstream:

- Replaced Supabase Auth and Postgres with a self-hosted Microsoft SQL
  Server backend and a bcrypt + JWT auth layer.
- Added Microsoft Azure OpenAI as an LLM provider alongside Anthropic
  Claude and Google Gemini, and made it the default.
- Replaced the Cloudflare R2 storage adapter with a pluggable storage
  layer supporting local filesystem (default for development) and Azure
  Blob Storage / mounted Azure Files (for Azure App Service).
- Removed Cloudflare-specific build targets and OpenNext tooling.
- Added Dockerfiles and a Docker Compose definition for local
  Microsoft SQL Server.

The full source — including these modifications — is published in this
repository to satisfy AGPL-3.0 §13 (remote network interaction).
