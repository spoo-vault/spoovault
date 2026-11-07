# 🌐 SpooVault Multi-Language Documentation (i18n)

Welcome to the **SpooVault Internationalization (i18n) Documentation Hub**. To make trustless document custody, Dead Man's Switch inheritance, and Soroban smart contract security accessible to a global audience, key documentation sections, the main `README`, and the protocol `ARCHITECTURE` overview are localized into multiple languages.

---

## 📚 Available Translations

| Language | Locale | README | Protocol Architecture Summary | Status |
| :--- | :--- | :--- | :--- | :--- |
| **English** *(Source)* | `en` | [README.md](../../README.md) | [docs/ARCHITECTURE.md](../ARCHITECTURE.md) | ✅ Canonical |
| **Español** *(Spanish)* | `es` | [docs/i18n/es/README.md](es/README.md) | [docs/i18n/es/ARCHITECTURE.md](es/ARCHITECTURE.md) | ✅ Active |
| **简体中文** *(Mandarin)* | `zh` | [docs/i18n/zh/README.md](zh/README.md) | [docs/i18n/zh/ARCHITECTURE.md](zh/ARCHITECTURE.md) | ✅ Active |
| **Français** *(French)* | `fr` | [docs/i18n/fr/README.md](fr/README.md) | [docs/i18n/fr/ARCHITECTURE.md](fr/ARCHITECTURE.md) | ✅ Active |

---

## 🗂️ Directory Structure

```text
docs/i18n/
├── README.md               # i18n index & contributor translation guide
├── es/                     # Spanish (Español)
│   ├── README.md
│   └── ARCHITECTURE.md
├── zh/                     # Mandarin Chinese (简体中文)
│   ├── README.md
│   └── ARCHITECTURE.md
└── fr/                     # French (Français)
    ├── README.md
    └── ARCHITECTURE.md
```

---

## 🤝 Contributing & Reviewing Translations

We actively encourage global community contributors to review existing translations, improve technical terminology, or propose new locales (e.g., `pt`, `de`, `ja`, `ko`, `ar`).

### Guidelines for Translators & Reviewers

1. **Preserve Technical Identifiers:**
   - Keep code blocks, CLI commands, environment variable names (`VITE_STELLAR_NETWORK`, `VITE_SPOOVUALT_PROXY_SECRET`), smart contract function names (`prove_life`, `_approveAccess`, `fulfill_emergency_unlock_delay`), and file paths untranslated.
   - Keep cryptographic standards (`AES-256-GCM`, `ECIES`, `Shamir's Secret Sharing (SSS)`, `Argon2id`, `OPAQUE`, `BLS12-381`, `PIR`) clear by retaining the canonical acronym alongside the localized term.
2. **Maintain Structural Parity:**
   - Keep heading levels, tables, and Mermaid diagrams aligned with the English source documents (`README.md` and `docs/ARCHITECTURE.md`) so diffs remain easy to audit.
3. **Submitting a Translation Update or Review:**
   - Fork the repository and create a branch (`docs/i18n-<locale>-<topic>`).
   - Submit a Pull Request referencing the relevant issue and tag native-speaking community reviewers.
