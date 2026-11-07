# SpooVault 系统架构详解 (简体中文)

> 🌍 **语言切换：** [English](../../ARCHITECTURE.md) • [Español](../es/ARCHITECTURE.md) • **简体中文** • [Français](../fr/ARCHITECTURE.md)

SpooVault 是一个企业级文档托管与秘密共享平台，支持在 **Avalanche (EVM)** 与 **Stellar (Soroban)** 网络上进行双链运行。

---

## 1. 高层系统拓扑结构

```text
+-----------------------------------------------------------------------------------+
|                                  SpooVault React DApp                             |
|    +-----------------------+   +------------------------+   +-------------------+ |
|    | 客户端 AES-256 加密   |   | Shamir 秘密共享 (SSS)  |   | TweetNaCl 公钥盒  | |
|    +-----------------------+   +------------------------+   +-------------------+ |
+------------------------------------------+----------------------------------------+
                                           |
                    +----------------------+----------------------+
                    |                                             |
                    v                                             v
     +------------------------------+             +-------------------------------+
     |   Avalanche C-Chain (EVM)    |             |    Stellar 网络 (Soroban)     |
     |   - SpooVault.sol            |             |    - SpooVault Soroban 合约   |
     |   - 文档元数据注册表         |             |    - 守护者门限配置           |
     |   - 守护者共识金库           |             |    - 密钥释放请求队列         |
     |   - 访问通行证 NFT           |             |                               |
     +------------------------------+             +-------------------------------+
                    |                                             |
                    +----------------------+----------------------+
                                           |
                                           v
                             +--------------------------+
                             |     去中心化存储层       |
                             |  - IPFS 网关代理与熔断器 |
                             |  - 加密载荷 CID          |
                             +--------------------------+
```

---

## 2. 密码学安全模型

1. **零知识上传（Zero-Knowledge Upload）：** 文档在发送至 IPFS 之前，完全在客户端使用 `AES-256-GCM` 进行加密。未加密的原始文档绝不会触及服务器或区块链内存。
2. **基于 Shamir 秘密共享（SSS）的密钥拆分：** 主加密密钥被拆分为 $(k, n)$ 门限分片，并通过 `TweetNaCl` 公钥加密盒（Public-Key Box）安全分发给指定守护者的公钥。
3. **门限密钥重构：** 受益人发起文档释放请求，守护者在链上独立审核并批准请求。当达到所需的 $n$ 中取 $k$ 签名门限后，加密密钥包将被释放并在客户端本地组装以完成文档解密。
4. **禁止自批准不变量（No Self-Approval Invariant）：** 访问批准绝不能来自发起请求的受益人自身。当 `msg.sender == request.requester` 时，`_approveAccess` 会以 `CannotSelfApproveAccess` 回滚，确保法定人数仅统计除请求者以外的不同已接受守护者。
5. **VRF / PRNG 紧急解锁随机抖动（Jitter）：** 紧急释放不使用可预测的固定延迟：
   - 在 **Avalanche** 上，`setEmergencyMode(true)` 请求 Chainlink VRF v2.5 熵，并同时写入随机时间戳上限（`T_random = VRF() mod Delta_T`）与区块高度下限（至少 `baseDelayBlocks + 256` 个附加区块）。
   - 在 **Soroban (Stellar)** 上，经过至少 3 个确认账本后通过 `fulfill_emergency_unlock_delay` 从 `env.prng()` 派生双重时间戳与账本序列边界，防止验证者或守护者提前串通预测精确的解锁账本。

---

## 3. 双链智能合约层

### Avalanche (Solidity `SpooVault.sol`)
- 在 Avalanche Fuji 测试网（Chain ID `43113`）上管理文档元数据记录、金库配置、守护者门限以及 NFT 访问通行证铸造。
- 集成可选的 Chainlink VRF v2.5 消费者，用于可验证随机紧急延迟。

### Stellar (Soroban Rust 合约)
- 使用原生 Rust Soroban SDK 数据结构在 Stellar Soroban 测试网上管理文档注册表、守护者审批、失能开关（`prove_life`）以及密钥收件箱分发。

---

## 4. IPFS 存储、网关连接池与熔断器

为防止客户端泄露 Pinata API 凭证：

- 生产环境的固定（pin）与取消固定（unpin）请求均通过 `scripts/pinata-proxy.mjs` 路由，Pinata JWT 仅保存在服务端。
- CORS 严格限制为 `SPOOVUALT_ALLOWED_ORIGINS`，禁用通配符 `*`。
- 每次调用 `/api/ipfs/*` 均需携带请求头 `X-SpooVault-Signature: t=<unix>,v1=<hmac-sha256-hex>`，由前端使用 `VITE_SPOOVUALT_PROXY_SECRET` 签名（参见 `scripts/lib/ipfsProxyGuard.mjs`）。
- **密钥信封垃圾回收（`keyEnvelopeGCService`）：** 自动识别已过期或已拒绝的访问请求，并通过 `DELETE /api/ipfs/unpin/:hash` 自动清理 IPFS 上不再需要的密钥信封。
- **多网关并发竞速与熔断器（`src/services/ipfsGateway.ts`）：** 下载请求在 Pinata、Infura、Cloudflare 与 IPFS.io 之间并行竞速。任何返回 HTTP 429、超时或 5xx 的网关将触发 30 秒熔断。

---

## 5. 隐私信息检索 (PIR)

为防止 IPFS 网关监控请求者 IP 地址与目标 CID 之间的关联，SpooVault 在 `src/services/pir.service.ts` 中实现了隐私信息检索机制：

1. **`HomomorphicHash`：** 使用带会话盐值的 `SHA-256` 生成不可逆的会话级确定性 CID 哈希。
2. **`DummyQueryBatcher`：** 生成逼真的诱饵 CIDv0 查询，将真实查询与诱饵查询混合打乱后批量发送（默认混入 5 个诱饵查询），隐藏真实访问目标。
3. **`TorProxyClient`：** 支持通过本地 Tor SOCKS5 代理（默认 `127.0.0.1:9050`）路由 IPFS 请求以实现 IP 匿名化。

---

## 6. 虚拟化列表渲染

`Documents.tsx`、`NFTGallery.tsx` 与 `AuditLogTimeline.tsx` 使用 `@tanstack/react-virtual`（动态行高测量 `measureElement`）对文档表格、NFT 访问通行证网格及审计日志时间线进行 DOM 窗口化渲染。即使列表包含 10,000 条记录，挂载的 DOM 节点数始终保持在 50 个以内。

---

## 7. Soroban 事件索引器与读取缓存

- **事件索引器（`src/services/sorobanEventIndexer.service.ts`）：** 结合带指数退避重连的 RPC 轮询、按主题索引的本地 IndexedDB 存储（`EventStore`）以及实时 WebSocket 广播网关（`scripts/soroban-event-gateway.mjs`），实现 `< 500ms` 的前端状态更新延迟。
- **只读调用缓存（`src/utils/ttlCache.ts`）：** `contract.service.ts` 对只读查询（`hasActiveAccess`、`getVault`）提供 10 秒 TTL 缓存与并发去重，并在发生写入交易时立即使相关缓存失效。

---

## 8. 紧急模式受益人推送通知 (Push Protocol / EPNS)

当金库切换紧急模式时，`Vaults.tsx` 会查询金库绑定的受益人地址（`contractService.getBeneficiary`），并通过服务端无服务器代理 `scripts/push-notification-proxy.mjs` 发送 Push Protocol 通知，确保通道私钥永不暴露于浏览器端。
