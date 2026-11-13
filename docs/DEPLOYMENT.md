# Deployment notes

## Windows
1. Install Node.js LTS.
2. Extract the project to a folder such as `C:\NEXUS`.
3. Open PowerShell in that folder.
4. Run `Copy-Item .env.example .env` and edit `.env`.
5. Run `npm install`, `npm run register`, then `npm start`.

## Linux
```bash
cp .env.example .env
nano .env
npm install
npm run register
npm start
```

For a persistent Linux service, use systemd or a process manager after testing. For Windows, use Task Scheduler or a Windows service wrapper.

## Cloudflare Tunnel
Keep the API bound to localhost and route a hostname to `http://127.0.0.1:8787` through a tunnel. Protect API endpoints with the `x-api-key` header. Do not expose `/api` to a public browser without a backend that keeps the key secret.
