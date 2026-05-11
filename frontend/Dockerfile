# Frontend image. Build happens on the host (`npm run build`), then the
# container only installs production deps and runs `next start`.

FROM node:20-bookworm-slim

WORKDIR /app

# Production dependencies (next, react, etc.). devDeps are unnecessary
# in the runtime image since next build already ran on the host.
COPY package.json package-lock.json* ./
ENV NPM_CONFIG_STRICT_SSL=false
RUN npm ci --omit=dev

# Build output + static assets + next.config.ts (read by `next start`)
COPY .next ./.next
COPY public ./public
COPY next.config.js ./

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["npm", "run", "start"]
