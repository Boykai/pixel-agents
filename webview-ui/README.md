# React + TypeScript + Vite

## Generate Room

Open **Layout**, then select **Generate Room** to add a furnished workspace,
meeting room, or lounge. Each interior is randomly chosen from 5 to 8 tiles wide
and 5 to 8 tiles high, before furnishing. A one-tile wall perimeter lies outside
those dimensions. The room attaches through an open passage to existing
walkable floor, including hand-built layouts without enclosing walls.

Generation uses small arrangements made from available bundled catalog assets:
a desk/chair/computer, a meeting table with chairs, or a sofa and coffee table,
each with decor. Larger rooms can receive additional workspaces or seats. The
generator keeps an aisle clear and verifies each seat is reachable with other
chairs still blocked. Missing theme assets are reported; if nothing usable fits,
the existing layout stays unchanged. It never downloads assets or uses an
external generation service.

Existing floor, furniture, entrances, carpets, and Areas are preserved. The
generator first searches unused space inside the grid, then tries expansion up
to the existing 64-by-64 limit. Geometry, furniture, the connecting opening, and
expansion form one Undo/Redo edit; Redo restores the same room and furniture IDs.
Left/up expansion and reversal retain the coordinate relationships of all layers
and inhabitants. Undo relocates occupants safely when their room disappears.

The camera reveals the new room and the editor returns to Select. All generated
tiles and furnishings remain editable normally. Chairs and sofas create ordinary
assignable seats; generation does not create Areas or change folder mappings.
Save/Reset, debounced persistence, import/export, and both adapters use the same
version-1 layout format. As with other edits, changes autosave; **Save** also
sets the checkpoint used by **Reset**.

## Provider-aware office

The shared office renders both standalone and VS Code sessions. Provider capability messages
scope tool animations and Sub-agent classification by `providerId`; a provider's tool names
must never become another provider's classifications. Legacy snapshots without a provider
retain Claude behavior.

Settings shows each enabled provider's actual hook installation state and its own disclosure.
Installed hooks do not prove event delivery. Unknown observations keep the last activity state
but hide the character and its sub-agents until activity is observed again, without announcing completion.
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
