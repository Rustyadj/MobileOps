FROM node:20-alpine AS build

WORKDIR /app

RUN corepack enable && corepack prepare yarn@1.22.22 --activate

COPY package.json yarn.lock ./
COPY scripts ./scripts
RUN yarn install --frozen-lockfile --non-interactive

COPY . .

ARG EXPO_PUBLIC_BACKEND_URL
ENV EXPO_PUBLIC_BACKEND_URL=${EXPO_PUBLIC_BACKEND_URL} \
    NODE_ENV=production

RUN yarn expo export --platform web --output-dir dist

FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD wget -qO- http://127.0.0.1/healthz >/dev/null || exit 1
