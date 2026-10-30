# Copy and Paste

Partage de texte, d'images et de vidéos entre appareils d'un même réseau, sans compte. Tout s'efface après une heure.

Les appareils sont regroupés par IP publique, transformée en identifiant HMAC et jamais stockée. Un code à 6 caractères ou un QR code relie un appareil sur un autre réseau.

## Stack

Cloudflare Workers pour l'API et les fichiers statiques, Durable Objects (SQLite) pour les salons et le direct par WebSocket, R2 pour les fichiers.

## Développement

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

Puis, dans un autre terminal :

```bash
npm run smoke
```

## Déploiement

1. Créer le bucket R2 `copy-and-paste-files`.
2. Ajouter une règle de cycle de vie sur ce bucket : suppression après 1 jour et abandon des envois incomplets après 1 jour. L'alarme du salon supprime déjà tout après une heure, cette règle sert de filet.
3. Définir le secret `ROOM_SECRET` avec une longue valeur aléatoire (`npx wrangler secret put ROOM_SECRET`).
4. Le repo est relié à Workers Builds : chaque push sur `main` déploie le site. `npm run deploy` reste possible à la main.

## Limites

Texte : 100 000 caractères. Fichier : 200 Mo, images et vidéos uniquement. Salon : 50 contenus et 2 Go.
