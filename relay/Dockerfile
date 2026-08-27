# Single-file relay image: the bundle includes ws, so the runtime needs
# nothing but node.
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY relay/ relay/
COPY src/shared/remote-protocol.ts src/shared/remote-protocol.ts
RUN npx esbuild relay/src/index.ts \
    --bundle --platform=node --format=esm --target=node22 \
    --alias:@shared=./src/shared \
    --outfile=relay/relay.mjs

FROM node:22-alpine
WORKDIR /relay
ENV PORT=8790 HOST=0.0.0.0 STORE_PATH=/data/relay-store.json
COPY --from=build /repo/relay/relay.mjs ./relay.mjs
VOLUME /data
EXPOSE 8790
CMD ["node", "relay.mjs"]
