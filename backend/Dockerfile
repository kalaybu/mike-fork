# Two-stage build, but compilation happens OUTSIDE the container.
# Run `npm run build` on the host first so the corporate proxy doesn't
# interfere with npm registry traffic during `docker build`. The image
# then only needs production deps.

FROM node:20-bookworm-slim AS runtime

# LibreOffice for DOCX/DOC → PDF conversion. fonts-liberation gives us the
# standard Office font set. tini is a tiny init that reaps zombie soffice
# child processes correctly.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libreoffice \
        fonts-liberation \
        tini \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production deps only (devDependencies are unnecessary in the
# runtime image — tsc has already done its job on the host).
COPY package.json package-lock.json* ./
ENV NPM_CONFIG_STRICT_SSL=false
RUN npm ci --omit=dev

# Copy the pre-compiled output and the migrations directory.
COPY dist ./dist
COPY migrations ./migrations

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
