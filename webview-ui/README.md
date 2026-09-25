# React + TypeScript + Vite

## Provider-aware office

The shared office renders both standalone and VS Code sessions. Provider capability messages
scope tool animations and Sub-agent classification by `providerId`; a provider's tool names
must never become another provider's classifications. Legacy snapshots without a provider
retain Claude behavior.

Settings shows each enabled provider's actual hook installation state and its own disclosure.
Installed hooks do not prove event delivery. Unknown observations keep the last activity state
but pause character animation and clear speech bubbles, without announcing completion.
Recovered status messages do not replay sounds or finished-turn bubbles. Renaming a session
updates its label without recreating its character or changing seats, palette, or selection.

VS Code exposes launch-provider selection when multiple providers are enabled. Standalone
remains an observer and does not offer terminal launch/focus or guessed Copilot App links.
Hook installs are shared across adapters. VS Code uninstall conservatively retains hooks and
consent rather than disrupting standalone; disable each provider in Settings first if you
want to remove its shared hooks.

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) (or [oxc](https://oxc.rs) when used in [rolldown-vite](https://vite.dev/guide/rolldown)) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
]);
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x';
import reactDom from 'eslint-plugin-react-dom';

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
]);
```

### Agent hover details

Always-visible labels show the normalized project name, not activity or status.
Repository owners and generated Copilot worktree names are omitted; original
project spelling is preserved. Children inherit their parent's project, and
missing metadata is shown as "No project". Hover a character or its label to
inspect one opaque, scrollable details panel with the supplied project, session,
role, source, current activity and context usage. Label buttons also support
keyboard focus and tapping; selection keeps details available. Escape or
**Hide agent details** dismisses the panel without dismissing the agent.
