# syntax=docker/dockerfile:1
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY . .
ENV VITE_API_BASE_URL=/api/v1
RUN npm run build

FROM nginx:stable-alpine@sha256:3bc3836dc0be3b811f238210360bf8e7ca8a2d0effdae46160bf1f3578710051
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/dist/ /usr/share/nginx/html/
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --retries=4 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/readyz || exit 1
