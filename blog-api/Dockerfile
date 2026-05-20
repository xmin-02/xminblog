FROM node:22-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build:node

FROM node:22-slim AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY home-server.mjs schema.sql schema.postgres.sql ./
COPY scripts ./scripts
EXPOSE 3000
CMD ["node", "home-server.mjs"]
