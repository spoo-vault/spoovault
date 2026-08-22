# Release Conditions & Proof-of-Life Timers

Vaults can be configured to release documents automatically under specific circumstances, such as inactivity.

## Release Modes

1. **Anytime**: Instant access.
2. **LiveOnly**: Accessible only while the owner is actively verifying their presence.
3. **EmergencyOnly**: Accessible in emergency mode or if the owner is inactive.
4. **PostDeathOnly**: Unlocked strictly after the inactivity threshold is exceeded.

## Proof-of-Life Mechanism

- The vault creator records a "Proof of Life" on-chain (`proveLife`).
- If no proof is registered for longer than the `inactivityPeriod` (e.g., 30 days), the vault enters a "post-death" status, allowing beneficiary requests.
