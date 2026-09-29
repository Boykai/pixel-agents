import { useRef, useState } from 'react';

import { isSoundEnabled, setSoundEnabled } from '../notificationSound.js';
import type { HooksFeedback, ProviderSettings } from '../providerState.js';
import { isBrowserRuntime } from '../runtime.js';
import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';
import { Checkbox } from './ui/Checkbox.js';
import { MenuItem } from './ui/MenuItem.js';
import { Modal } from './ui/Modal.js';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  isDebugMode: boolean;
  onToggleDebugMode: () => void;
  alwaysShowOverlay: boolean;
  onToggleAlwaysShowOverlay: () => void;
  /** Whether headless agents (adopted, no terminal to focus) render translucent. */
  ghostHeadlessAgents: boolean;
  onToggleGhostHeadlessAgents: () => void;
  /** Whether characters show transient Mood bubbles (happy / error / stressed). */
  moodBubbles: boolean;
  onToggleMoodBubbles: () => void;
  /** Whether an unlocked Achievement shows a popup (the gallery records it either way). */
  achievementPopups: boolean;
  onToggleAchievementPopups: () => void;
  /** Opens the Achievement gallery over this modal. */
  onOpenAchievements: () => void;
  externalAssetDirectories: string[];
  watchAllSessions: boolean;
  onToggleWatchAllSessions: () => void;
  providers: ProviderSettings[];
  /** Actual on-disk state, independent of preference and event connectivity. */
  hooksInstalled: Record<string, boolean>;
  hooksFeedback: Record<string, HooksFeedback>;
  onToggleHooksEnabled: (providerId: string) => void;
  /** Whether the areas overlay is rendered outside of the Areas edit tool. */
  showAreas: boolean;
  onToggleShowAreas: () => void;
  /** Hide the Show Areas checkbox entirely when areas are unavailable. */
  showAreasAvailable: boolean;
  /** Browser-native layout export (standalone only; VS Code uses the host save dialog). */
  onExportLayout: () => void;
  /** Browser-native layout import from a chosen file (standalone only). */
  onImportLayout: (file: File) => void;
}

export function SettingsModal({
  isOpen,
  onClose,
  isDebugMode,
  onToggleDebugMode,
  alwaysShowOverlay,
  onToggleAlwaysShowOverlay,
  ghostHeadlessAgents,
  onToggleGhostHeadlessAgents,
  moodBubbles,
  onToggleMoodBubbles,
  achievementPopups,
  onToggleAchievementPopups,
  onOpenAchievements,
  externalAssetDirectories,
  watchAllSessions,
  onToggleWatchAllSessions,
  hooksInstalled,
  hooksFeedback,
  providers,
  onToggleHooksEnabled,
  showAreas,
  onToggleShowAreas,
  showAreasAvailable,
  onExportLayout,
  onImportLayout,
}: SettingsModalProps) {
  const [soundLocal, setSoundLocal] = useState(isSoundEnabled);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [assetDirDraft, setAssetDirDraft] = useState('');
  const [confirmProviderId, setConfirmProviderId] = useState<string | null>(null);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Settings"
      className="min-w-0! w-[min(480px,calc(100vw-32px))] max-h-[calc(100dvh-32px)] overflow-y-auto"
    >
      <MenuItem onClick={onOpenAchievements}>Achievements</MenuItem>
      {/* Open Sessions Folder opens an OS file manager — impossible in the browser. */}
      {!isBrowserRuntime && (
        <MenuItem
          onClick={() => {
            transport.send({ type: 'openSessionsFolder' });
            onClose();
          }}
        >
          Open Sessions Folder
        </MenuItem>
      )}
      <MenuItem
        onClick={() => {
          if (isBrowserRuntime) {
            onExportLayout();
          } else {
            transport.send({ type: 'exportLayout' });
          }
          onClose();
        }}
      >
        Export Layout
      </MenuItem>
      <MenuItem
        onClick={() => {
          if (isBrowserRuntime) {
            // Open the native file picker; the import is applied in onChange below.
            fileInputRef.current?.click();
          } else {
            transport.send({ type: 'importLayout' });
            onClose();
          }
        }}
      >
        Import Layout
      </MenuItem>
      {isBrowserRuntime && (
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Reset the value so re-selecting the same file fires change again.
            e.target.value = '';
            if (file) {
              onImportLayout(file);
              onClose();
            }
          }}
        />
      )}
      {/* Browser has no native directory picker, so accept a typed absolute path. */}
      {isBrowserRuntime ? (
        <div className="flex items-center gap-4 py-4 px-10">
          <input
            type="text"
            value={assetDirDraft}
            placeholder="Absolute asset directory path"
            onChange={(e) => setAssetDirDraft(e.target.value)}
            className="flex-1 min-w-0 text-xs py-2 px-4 bg-bg border-2 border-border rounded-none text-text"
          />
          <Button
            variant="default"
            size="sm"
            onClick={() => {
              const path = assetDirDraft.trim();
              if (!path) return;
              transport.send({ type: 'addExternalAssetDirectory', path });
              setAssetDirDraft('');
            }}
            className="shrink-0"
          >
            Add
          </Button>
        </div>
      ) : (
        <MenuItem
          onClick={() => {
            transport.send({ type: 'addExternalAssetDirectory' });
            onClose();
          }}
        >
          Add Asset Directory
        </MenuItem>
      )}
      {externalAssetDirectories.map((dir) => (
        <div key={dir} className="flex items-center justify-between py-4 px-10 gap-8">
          <span
            className="text-xs text-text-muted overflow-hidden text-ellipsis whitespace-nowrap"
            title={dir}
          >
            {dir.split(/[/\\]/).pop() ?? dir}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => transport.send({ type: 'removeExternalAssetDirectory', path: dir })}
            className="shrink-0"
          >
            x
          </Button>
        </div>
      ))}
      <Checkbox
        label="Sound Notifications"
        checked={soundLocal}
        onChange={() => {
          const newVal = !isSoundEnabled();
          setSoundEnabled(newVal);
          setSoundLocal(newVal);
          transport.send({ type: 'setSoundEnabled', enabled: newVal });
        }}
      />
      <Checkbox
        label="Watch All Sessions"
        checked={watchAllSessions}
        onChange={onToggleWatchAllSessions}
      />
      {providers.map((provider) => (
        <div key={provider.providerId}>
          <Checkbox
            label={`${provider.displayName} — Instant Detection (Hooks)`}
            checked={hooksInstalled[provider.providerId] === true}
            disabled={
              provider.capabilities?.hooks === false ||
              hooksFeedback[provider.providerId]?.canManage === false ||
              hooksInstalled[provider.providerId] === undefined
            }
            onChange={() => {
              if (hooksInstalled[provider.providerId]) {
                onToggleHooksEnabled(provider.providerId);
              } else {
                setConfirmProviderId(provider.providerId);
              }
            }}
          />
          <p className="text-xs text-text-muted px-10 m-0 mb-8">
            {provider.capabilities?.hooks === false
              ? 'Hook installation is unavailable for this provider.'
              : hooksInstalled[provider.providerId] === undefined
                ? 'Checking installation…'
                : hooksInstalled[provider.providerId]
                  ? 'Installed. Event delivery depends on the running session.'
                  : 'Not installed. Available transcript observations remain enabled.'}
          </p>
          {hooksFeedback[provider.providerId]?.canManage === false && (
            <p className="text-xs text-text px-10 m-0 mb-8">
              Hook changes are locked for this connection. Open the latest URL printed by the Pixel
              Agents server (including ?token=...) to install or remove hooks. Transcript watching
              still works.
            </p>
          )}
          {hooksFeedback[provider.providerId]?.error && (
            <p role="alert" className="text-xs text-text px-10 m-0 mb-8 wrap-anywhere">
              {hooksFeedback[provider.providerId].error}
            </p>
          )}
          {provider.capabilities?.permissionRequests === false && (
            <p className="text-xs text-text-muted px-10 m-0 mb-8">
              Permission detection is unavailable from this provider's current sources.
            </p>
          )}
          {provider.capabilities?.contextUsage === false && (
            <p className="text-xs text-text-muted px-10 m-0 mb-8">
              Context occupancy is unavailable from this provider's current sources.
            </p>
          )}
          {provider.capabilities?.subagents === false && (
            <p className="text-xs text-text-muted px-10 m-0 mb-8">
              Sub-agent activity is unavailable from this provider's current sources.
            </p>
          )}
          {confirmProviderId === provider.providerId &&
            hooksFeedback[provider.providerId]?.canManage !== false && (
              <div className="px-10 pb-8">
                {(
                  provider.disclosure ??
                  'Hook installation details are unavailable. Reopen the office to refresh them.'
                )
                  .split('\n\n')
                  .map((paragraph, index) => (
                    <p key={index} className="text-sm mb-8">
                      {paragraph}
                    </p>
                  ))}
                <div className="flex gap-8 flex-wrap">
                  <Button
                    variant="accent"
                    disabled={!provider.disclosure}
                    onClick={() => {
                      onToggleHooksEnabled(provider.providerId);
                      setConfirmProviderId(null);
                    }}
                  >
                    Install hooks
                  </Button>
                  <Button onClick={() => setConfirmProviderId(null)}>Cancel</Button>
                </div>
              </div>
            )}
        </div>
      ))}
      <Checkbox
        label="Always Show Labels"
        checked={alwaysShowOverlay}
        onChange={onToggleAlwaysShowOverlay}
      />
      <Checkbox label="Mood Bubbles" checked={moodBubbles} onChange={onToggleMoodBubbles} />
      <Checkbox
        label="Achievement Popups"
        checked={achievementPopups}
        onChange={onToggleAchievementPopups}
      />
      {/* Headless agents are the office's only terminal-less citizens in VS Code.
          Standalone has no terminals at all, so nothing there would ever ghost. */}
      {!isBrowserRuntime && (
        <Checkbox
          label="Display Headless as Ghosts"
          checked={ghostHeadlessAgents}
          onChange={onToggleGhostHeadlessAgents}
        />
      )}
      {showAreasAvailable && (
        <Checkbox label="Show Areas" checked={showAreas} onChange={onToggleShowAreas} />
      )}
      <Checkbox label="Debug View" checked={isDebugMode} onChange={onToggleDebugMode} />
    </Modal>
  );
}
