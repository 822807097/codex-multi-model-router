FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV CURSOR_SDK_BRIDGE_HOST=0.0.0.0
ENV CURSOR_SDK_BRIDGE_PORT=8792

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY scripts/cursor-sdk-local-agent-bridge.mjs ./scripts/cursor-sdk-local-agent-bridge.mjs

EXPOSE 8792

HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:8792/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

USER node

CMD ["node", "scripts/cursor-sdk-local-agent-bridge.mjs"]
