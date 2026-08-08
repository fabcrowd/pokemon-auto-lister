# Pokémon Card Auto-Lister

Personal Windows toolkit that turns phone photos into Mercari and/or eBay drafts (never published).

Full spec: [docs/autopilot/pokemon-auto-lister/pokemon-auto-lister.md](docs/autopilot/pokemon-auto-lister/pokemon-auto-lister.md)

## Setup

```bash
npm install
cp .env.example .env   # fill in PGAI_KEY, EBAY_*, TCGPLAYER_* credentials
```

## Run the dashboard

```bash
npm start
```

Binds to `HOST:PORT` from `.env` (LAN interface) so phones on the same Wi-Fi can reach `http://<PC-LAN-IP>:<PORT>`.

## Development

```bash
npm test   # node --test tests/
npm run lint
```
