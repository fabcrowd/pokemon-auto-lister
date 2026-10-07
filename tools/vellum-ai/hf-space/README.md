---
title: Pokemon Card Scanner
emoji: 🃏
colorFrom: red
colorTo: yellow
sdk: docker
app_port: 7860
pinned: false
---

# Pokémon Card Scanner — API Server

FastAPI server that detects and identifies Pokémon cards from webcam frames.
Used as the backend for the Pokemon Card Price Scanner Chrome extension.

**POST /detect** — accepts a base64 JPEG, returns card identities + TCGPlayer prices.  
**GET /health** — liveness check.
