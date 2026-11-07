# Architecture du Système SpooVault (Français)

> 🌍 **Langues :** [English](../../ARCHITECTURE.md) • [Español](../es/ARCHITECTURE.md) • [简体中文](../zh/ARCHITECTURE.md) • **Français**

SpooVault est une application de garde de documents et de partage de secrets de classe entreprise prenant en charge un fonctionnement double chaîne sur les réseaux **Avalanche (EVM)** et **Stellar (Soroban)**.

---

## 1. Topologie Globale du Système

```text
+-----------------------------------------------------------------------------------+
|                                  SpooVault React DApp                             |
|    +-----------------------+   +------------------------+   +-------------------+ |
|    | AES-256 Côté Client   |   | Shamir Secret Sharing  |   | TweetNaCl Box     | |
|    +-----------------------+   +------------------------+   +-------------------+ |
+------------------------------------------+----------------------------------------+
                                           |
                    +----------------------+----------------------+
                    |                                             |
                    v                                             v
     +------------------------------+             +-------------------------------+
     |   Avalanche C-Chain (EVM)    |             |    Réseau Stellar (Soroban)   |
     |   - SpooVault.sol            |             |    - Contrat Soroban          |
     |   - Registre de Métadonnées  |             |    - Seuils de Gardiens       |
     |   - Coffres de Consensus     |             |    - Demandes de Libération   |
     |   - Pass d'Accès NFT         |             |                               |
     +------------------------------+             +-------------------------------+
                    |                                             |
                    +----------------------+----------------------+
                                           |
                                           v
                             +--------------------------+
                             |  Stockage Décentralisé   |
                             |  - Proxy Passerelle IPFS |
                             |  - CID Données Chiffrées |
                             +--------------------------+
```

---

## 2. Modèle de Sécurité Cryptographique

1. **Téléversement Zero-Knowledge :** Les documents sont entièrement chiffrés côté client avec `AES-256-GCM` avant d'être envoyés sur IPFS. Les fichiers en clair ne transitent jamais par la mémoire d'un serveur ou de la blockchain.
2. **Division des Clés via le Partage de Secret de Shamir (SSS) :** Les clés maîtresses de chiffrement sont divisées en fragments à seuil $(k, n)$ et distribuées de manière sécurisée aux clés publiques des Gardiens désignés via le chiffrement asymétrique `TweetNaCl`.
3. **Reconstruction de Clé à Seuil :** Les bénéficiaires initient les demandes de libération de documents. Les gardiens examinent et approuvent indépendamment les demandes sur chaîne. Une fois le seuil requis de $k$ signatures sur $n$ atteint, les enveloppes de clés chiffrées sont libérées pour l'assemblage côté client et le déchiffrement.
4. **Invariant de Non Auto-Approbation :** Une approbation d'accès ne peut jamais provenir du bénéficiaire à l'origine de la demande. `_approveAccess` échoue avec `CannotSelfApproveAccess` lorsque `msg.sender == request.requester`, garantissant que le quorum ne compte que des gardiens distincts et acceptés autres que le demandeur.
5. **Gigue (Jitter) de Déverrouillage d'Urgence VRF / PRNG :** Les libérations d'urgence n'utilisent pas de délai fixe prévisible :
   - Sur **Avalanche**, `setEmergencyMode(true)` demande de l'entropie à Chainlink VRF v2.5 et enregistre une borne d'horodatage (`T_random = VRF() mod Delta_T`) ainsi qu'une borne de hauteur de bloc (`baseDelayBlocks + 256` blocs supplémentaires).
   - Sur **Soroban (Stellar)**, les mêmes bornes doubles sont dérivées de `env.prng()` après au moins 3 registres de confirmation via `fulfill_emergency_unlock_delay`.

---

## 3. Couche de Contrats Intelligents Double Chaîne

### Avalanche (Solidity `SpooVault.sol`)
- Gère les enregistrements de métadonnées de documents, la configuration des coffres, les seuils de gardiens et la frappe de pass d'accès NFT sur Avalanche Fuji Testnet (Chain ID `43113`).
- Consommateur Chainlink VRF v2.5 optionnel pour les délais d'urgence vérifiables.

### Stellar (Contrat Rust Soroban)
- Gère le registre des documents, les approbations des gardiens, l'interrupteur de l'homme mort (`prove_life`) et la boîte de réception des clés sur Stellar Soroban Testnet à l'aide des structures natives du SDK Soroban en Rust.

---

## 4. Stockage IPFS, Pool de Passerelles et Disjoncteur

Pour éviter toute fuite côté client des identifiants API Pinata :

- Les requêtes d'épinglage (*pin*) et de désépinglage (*unpin*) en production passent par `scripts/pinata-proxy.mjs`. Le jeton JWT Pinata reste sur le serveur.
- CORS est restreint à `SPOOVUALT_ALLOWED_ORIGINS`.
- Chaque appel `/api/ipfs/*` doit présenter l'en-tête `X-SpooVault-Signature: t=<unix>,v1=<hmac-sha256-hex>`, signé avec `VITE_SPOOVUALT_PROXY_SECRET` (`scripts/lib/ipfsProxyGuard.mjs`).
- **Ramasse-Miettes Automatisé des Enveloppes de Clés (`keyEnvelopeGCService`) :** Identifie les demandes d'accès expirées ou rejetées et désépingle automatiquement les enveloppes correspondantes via `DELETE /api/ipfs/unpin/:hash`.
- **Pool de Passerelles et Disjoncteur (`src/services/ipfsGateway.ts`) :** Les téléchargements mettent en concurrence plusieurs passerelles publiques (Pinata, Infura, Cloudflare, IPFS.io). Les erreurs HTTP 429, délais d'attente ou erreurs 5xx ouvrent le disjoncteur de la passerelle concernée pendant 30 secondes.

---

## 5. Récupération Privée d'Information (PIR)

Afin d'empêcher la surveillance des passerelles IPFS (corrélation entre l'adresse IP du demandeur et le CID consulté), SpooVault implémente des mécanismes PIR dans `src/services/pir.service.ts` :

1. **`HomomorphicHash` :** Génère des identifiants CID déterministes par session mais non réversibles via `SHA-256` salé.
2. **`DummyQueryBatcher` :** Regroupe et mélange les requêtes réelles avec des requêtes factices (CIDv0 synthétiques) pour masquer le document réellement demandé.
3. **`TorProxyClient` :** Achemine les requêtes IPFS via un proxy SOCKS5 Tor local (`127.0.0.1:9050`) pour anonymiser l'adresse IP.

---

## 6. Rendu de Listes Virtualisé

`Documents.tsx`, `NFTGallery.tsx` et `AuditLogTimeline.tsx` utilisent `@tanstack/react-virtual` (`measureElement`) pour virtualiser le DOM des listes de documents, des grilles de pass NFT et du journal d'audit, maintenant moins de 50 nœuds DOM montés même pour des listes de 10 000 éléments.

---

## 7. Indexeur d'Événements Soroban et Cache de Lecture

- **Indexeur d'Événements (`src/services/sorobanEventIndexer.service.ts`) :** Combine l'interrogation RPC avec reconnexion exponentielle, la persistance IndexedDB indexée par sujet (`EventStore`) et une passerelle WebSocket temps réel (`scripts/soroban-event-gateway.mjs`) offrant des mises à jour d'interface en `< 500 ms`.
- **Cache d'Appels en Lecture (`src/utils/ttlCache.ts`) :** `contract.service.ts` met en cache les appels en lecture seule (`hasActiveAccess`, `getVault`) pendant 10 secondes et déduplique les requêtes simultanées, avec invalidation immédiate lors des écritures.

---

## 8. Notifications Push aux Bénéficiaires en Mode d'Urgence

Lorsqu'un coffre bascule en Mode d'Urgence, `Vaults.tsx` résout l'adresse du bénéficiaire (`contractService.getBeneficiary`) et envoie une notification Push Protocol via le proxy sans serveur `scripts/push-notification-proxy.mjs`, protégeant la clé privée du canal sur le serveur.
