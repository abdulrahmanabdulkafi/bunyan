FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace apps/web
COPY apps/web apps/web
RUN npm --workspace apps/web run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/web apps/web
USER node
EXPOSE 3000
CMD ["npm", "--workspace", "apps/web", "start"]
