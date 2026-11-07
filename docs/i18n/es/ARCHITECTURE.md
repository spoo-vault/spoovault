# Arquitectura del Sistema SpooVault (Español)

> 🌍 **Idiomas:** [English](../../ARCHITECTURE.md) • **Español** • [简体中文](../zh/ARCHITECTURE.md) • [Français](../fr/ARCHITECTURE.md)

SpooVault es una aplicación empresarial de custodia de documentos y compartición de secretos que opera en doble cadena a través de las redes **Avalanche (EVM)** y **Stellar (Soroban)**.

---

## 1. Topología de Alto Nivel del Sistema

```text
+-----------------------------------------------------------------------------------+
|                                  SpooVault React DApp                             |
|    +-----------------------+   +------------------------+   +-------------------+ |
|    | AES-256 en Cliente    |   | Shamir Secret Sharing  |   | TweetNaCl Box     | |
|    +-----------------------+   +------------------------+   +-------------------+ |
+------------------------------------------+----------------------------------------+
                                           |
                    +----------------------+----------------------+
                    |                                             |
                    v                                             v
     +------------------------------+             +-------------------------------+
     |   Avalanche C-Chain (EVM)    |             |    Red Stellar (Soroban)      |
     |   - SpooVault.sol            |             |    - Contrato Soroban         |
     |   - Registro de Metadatos    |             |    - Umbrales de Guardianes   |
     |   - Bóvedas de Consenso      |             |    - Solicitudes de Liberación|
     |   - NFTs de Pase de Acceso   |             |                               |
     +------------------------------+             +-------------------------------+
                    |                                             |
                    +----------------------+----------------------+
                                           |
                                           v
                             +--------------------------+
                             | Almacenamiento Descentr. |
                             | - Proxy Gateway IPFS     |
                             | - CID de Datos Cifrados  |
                             +--------------------------+
```

---

## 2. Modelo de Seguridad Criptográfica

1. **Carga de Conocimiento Cero (Zero-Knowledge Upload):** Los documentos se cifran íntegramente del lado del cliente mediante `AES-256-GCM` antes de enviarse a IPFS. Los documentos sin cifrar nunca tocan la memoria del servidor ni la cadena de bloques.
2. **División de Claves mediante Shamir Secret Sharing (SSS):** Las claves maestras de cifrado se dividen en fragmentos de umbral $(k, n)$ y se distribuyen de forma segura a las claves públicas de los Guardianes designados mediante cifrado de caja de clave pública `TweetNaCl`.
3. **Reconstrucción de Claves por Umbral:** Los beneficiarios inician solicitudes de liberación de documentos. Los guardianes revisan y aprueban independientemente las solicitudes en cadena. Al alcanzarse el umbral requerido de $k$ de $n$ firmas, los paquetes de claves cifradas se liberan para su ensamblaje y descifrado en el cliente.
4. **Invariante de No Auto-Aprobación:** Una aprobación de acceso nunca puede originarse en el beneficiario solicitante. `_approveAccess` revierte con `CannotSelfApproveAccess` cuando `msg.sender == request.requester`, garantizando que el quórum cuente únicamente guardianes distintos y aceptados diferentes del solicitante.
5. **Jitter de Desbloqueo de Emergencia con VRF / PRNG:** Las liberaciones de emergencia no utilizan un retardo fijo predecible:
   - En **Avalanche**, `setEmergencyMode(true)` solicita entropía a Chainlink VRF v2.5 y registra tanto un límite de marca de tiempo (`T_random = VRF() mod Delta_T`) como un límite de altura de bloque (`baseDelayBlocks + 256` bloques adicionales).
   - En **Soroban (Stellar)**, los límites duales se derivan de `env.prng()` tras al menos 3 ledgers de confirmación mediante `fulfill_emergency_unlock_delay`, evitando que validadores o guardianes conozcan de antemano el ledger exacto de desbloqueo.

---

## 3. Capa de Contratos Inteligentes de Doble Cadena

### Avalanche (Solidity `SpooVault.sol`)
- Gestiona registros de metadatos de documentos, configuraciones de bóvedas, umbrales de guardianes y acuñación de pases de acceso NFT en Avalanche Fuji Testnet (Chain ID `43113`).
- Consumidor opcional de Chainlink VRF v2.5 para retardos de emergencia verificables.

### Stellar (Contrato Soroban en Rust)
- Gestiona el registro de documentos, aprobaciones de guardianes, interruptor de hombre muerto (`prove_life`) y distribución de buzones de claves en Stellar Soroban Testnet utilizando estructuras nativas del SDK de Soroban en Rust.

---

## 4. Almacenamiento IPFS, Pool de Gateways y Disyuntor (Circuit Breaker)

Para evitar la exposición de credenciales de la API de Pinata en el cliente:

- Las solicitudes de fijado (*pin*) y desfijado (*unpin*) en producción se enrutan a través de `scripts/pinata-proxy.mjs`. El JWT de Pinata permanece exclusivamente en el servidor.
- CORS está restringido a `SPOOVUALT_ALLOWED_ORIGINS`.
- Cada llamada a `/api/ipfs/*` debe presentar la cabecera `X-SpooVault-Signature: t=<unix>,v1=<hmac-sha256-hex>`, firmada con `VITE_SPOOVUALT_PROXY_SECRET` (`scripts/lib/ipfsProxyGuard.mjs`).
- **Recolección Automática de Basura (`keyEnvelopeGCService`):** Identifica solicitudes de acceso expiradas o rechazadas y elimina automáticamente los sobres de claves obsoletos en IPFS mediante `DELETE /api/ipfs/unpin/:hash`.
- **Pool de Gateways con Disyuntor (`src/services/ipfsGateway.ts`):** Las descargas compiten en paralelo entre múltiples gateways públicos (Pinata, Infura, Cloudflare, IPFS.io). Los errores HTTP 429, tiempos de espera agotados o errores 5xx abren el disyuntor de ese gateway durante 30 segundos.

---

## 5. Recuperación Privada de Información (PIR)

Para evitar la vigilancia en gateways IPFS (correlación de direcciones IP y CIDs solicitados), SpooVault implementa principios PIR en `src/services/pir.service.ts`:

1. **`HomomorphicHash`:** Genera identificadores CID deterministas por sesión pero no reversibles utilizando `SHA-256` con sal por sesión.
2. **`DummyQueryBatcher`:** Agrupa y mezcla consultas reales con consultas señuelo (CIDv0 sintéticos) para ocultar qué documento está recuperando el beneficiario.
3. **`TorProxyClient`:** Enruta las solicitudes IPFS a través de un proxy SOCKS5 de Tor (`127.0.0.1:9050`) para anonimizar la dirección IP, con conmutación automática si Tor no está disponible.

---

## 6. Renderizado Virtualizado de Listas

`Documents.tsx`, `NFTGallery.tsx` y `AuditLogTimeline.tsx` utilizan `@tanstack/react-virtual` (`VirtualizedDocumentsList.tsx`, `VirtualizedNftGrid.tsx` y `AuditLogTimeline.tsx`) con medición dinámica por fila (`measureElement`) para mantener menos de 50 nodos DOM montados incluso en bóvedas con más de 10.000 documentos o eventos de auditoría.

---

## 7. Indexador de Eventos Soroban y Caché de Lectura

- **Indexador de Eventos (`src/services/sorobanEventIndexer.service.ts`):** Combina sondeo RPC con reconexión exponencial, persistencia local en IndexedDB indexada por tópicos (`EventStore`) y retransmisión en tiempo real mediante pasarela WebSocket (`scripts/soroban-event-gateway.mjs`), logrando actualizaciones de interfaz en `< 500 ms`.
- **Caché de Llamadas de Lectura (`src/utils/ttlCache.ts`):** `contract.service.ts` almacena en caché las lecturas (`hasActiveAccess`, `getVault`) durante un TTL de 10 segundos y deduplica solicitudes simultáneas, invalidando automáticamente la caché tras cualquier transacción de escritura.

---

## 8. Notificaciones Push a Beneficiarios en Modo de Emergencia

Cuando se activa el Modo de Emergencia en una bóveda, `Vaults.tsx` resuelve el beneficiario designado (`contractService.getBeneficiary`) y notifica a través de `scripts/push-notification-proxy.mjs` (Push Protocol / EPNS) utilizando firmas HMAC sin exponer jamás la clave privada del canal en el navegador.
