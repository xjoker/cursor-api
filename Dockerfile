FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json VERSION ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
ARG GIT_COMMIT=unknown
ENV TZ=UTC \
    NODE_ENV=production \
    GIT_COMMIT=${GIT_COMMIT}
WORKDIR /app
RUN useradd --system --uid 1001 --home-dir /app --shell /usr/sbin/nologin app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY public ./public
COPY VERSION ./
RUN mkdir -p /app/data && chown -R app:app /app
USER app
EXPOSE 8787
CMD ["node", "dist/index.js"]
