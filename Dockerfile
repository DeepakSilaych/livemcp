FROM node:22-alpine AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build:server && npm pack --workspace livemcp --pack-destination /tmp

FROM node:22-alpine
COPY --from=build /tmp/livemcp-*.tgz /tmp/
RUN npm install --global /tmp/livemcp-*.tgz && rm /tmp/livemcp-*.tgz
USER node
ENV LIVEMCP_HOST=0.0.0.0 LIVEMCP_PORT=17691 LIVEMCP_DISABLE_IPC=1
EXPOSE 17691
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+process.env.LIVEMCP_PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["livemcp-hub"]
