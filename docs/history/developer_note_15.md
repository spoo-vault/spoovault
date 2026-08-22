# Frontend Context Routing & State Management (Zustand)

Global frontend states, wallet connections, and notifications are managed via state stores.

## State Management (Zustand)

We utilize lightweight Zustand stores to keep track of:

- Current active account address.
- Loaded vaults list.
- User encryption key status.
- Connected network parameters.

## Web3 Context Wrapper

The `Web3Context.tsx` wraps the React application, providing unified entry points to connect, switch networks, fetch balances, and trigger transactions, abstracts whether the active chain is EVM or Stellar.
