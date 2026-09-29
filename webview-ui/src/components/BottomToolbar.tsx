import type { FocusEvent as ReactFocusEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { AGENT_NICKNAME_MAX_LENGTH } from '../../../core/src/constants.js';
import { normalizeNickname } from '../../../core/src/normalizeNickname.js';
import { BOTTOM_TOOLBAR_CLEARANCE_VAR } from '../constants.js';
import type { WorkspaceFolder } from '../hooks/useExtensionMessages.js';
import type { ProviderSettings } from '../providerState.js';
import { isBrowserRuntime } from '../runtime.js';
import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';
import { Dropdown, DropdownItem } from './ui/Dropdown.js';

interface BottomToolbarProps {
  isEditMode: boolean;
  onLaunchAgent: (providerId?: string, nickname?: string) => void;
  providers: ProviderSettings[];
  launchProvider?: string;
  onToggleEditMode: () => void;
  isSettingsOpen: boolean;
  onToggleSettings: () => void;
  isActivityOpen: boolean;
  onToggleActivity: () => void;
  isUsageOpen: boolean;
  onToggleUsage: () => void;
  workspaceFolders: WorkspaceFolder[];
}

export function BottomToolbar({
  isEditMode,
  onLaunchAgent,
  providers,
  launchProvider,
  onToggleEditMode,
  isSettingsOpen,
  onToggleSettings,
  isActivityOpen,
  onToggleActivity,
  isUsageOpen,
  onToggleUsage,
  workspaceFolders,
}: BottomToolbarProps) {
  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState(false);
  const [isBypassMenuOpen, setIsBypassMenuOpen] = useState(false);
  const [chosenProvider, setChosenProvider] = useState<string>();
  // Optional nickname for the next agent, typed in the + Agent menu.
  const [nickname, setNickname] = useState('');
  const [isNicknameFocused, setIsNicknameFocused] = useState(false);
  const providerId = chosenProvider ?? launchProvider;
  const folderPickerRef = useRef<HTMLDivElement>(null);
  const agentButtonRef = useRef<HTMLButtonElement>(null);
  const pendingBypassRef = useRef(false);
  const toolbarRef = useRef<HTMLDivElement>(null);

  // Publish where the toolbar's top edge sits, so the surfaces stacked above
  // it move up when a narrow window wraps it onto more rows.
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    const root = toolbar?.parentElement;
    if (!toolbar || !root) return;
    const publish = () => {
      const clearance = root.clientHeight - toolbar.offsetTop;
      root.style.setProperty(BOTTOM_TOOLBAR_CLEARANCE_VAR, `${clearance}px`);
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(toolbar);
    return () => {
      observer.disconnect();
      root.style.removeProperty(BOTTOM_TOOLBAR_CLEARANCE_VAR);
    };
  }, []);

  // Close folder picker / bypass menu on outside click
  useEffect(() => {
    if (!isFolderPickerOpen && !isBypassMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (folderPickerRef.current && !folderPickerRef.current.contains(e.target as Node)) {
        setIsFolderPickerOpen(false);
        setIsBypassMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isFolderPickerOpen, isBypassMenuOpen]);

  const hasMultipleFolders = workspaceFolders.length > 1;

  /** The typed nickname, consumed by the launch it names. */
  const takeNickname = (): { nickname?: string } => {
    const name = normalizeNickname(nickname);
    setNickname('');
    return name ? { nickname: name } : {};
  };

  const handleAgentClick = () => {
    setIsBypassMenuOpen(false);
    pendingBypassRef.current = false;
    if (hasMultipleFolders) {
      setIsFolderPickerOpen((v) => !v);
    } else {
      onLaunchAgent(providerId, takeNickname().nickname);
    }
  };

  const handleAgentHover = () => {
    if (!isFolderPickerOpen) {
      setIsBypassMenuOpen(true);
    }
  };

  const handleAgentLeave = () => {
    // Keep the menu while a nickname is being typed.
    if (!isFolderPickerOpen && !isNicknameFocused && !nickname) {
      setIsBypassMenuOpen(false);
    }
  };

  /**
   * Hand focus back to + Agent before closing a menu that holds it, so a
   * keyboard user keeps their place instead of dropping to the page.
   */
  const focusAgentButton = () => agentButtonRef.current?.focus();

  // Keyboard users reach the menu by focus, as pointer users do by hover.
  const handleAgentFocus = (e: ReactFocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget)) handleAgentHover();
  };

  // Focus moving on to another control closes the menus, like a click outside.
  const handleAgentBlur = (e: ReactFocusEvent<HTMLDivElement>) => {
    if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) {
      setIsFolderPickerOpen(false);
      setIsBypassMenuOpen(false);
    }
  };

  /** Escape: drop the menus and the typed nickname, back on + Agent. */
  const dismissMenus = () => {
    focusAgentButton();
    setNickname('');
    setIsFolderPickerOpen(false);
    setIsBypassMenuOpen(false);
  };

  const handleAgentKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && (isBypassMenuOpen || isFolderPickerOpen)) {
      e.stopPropagation();
      dismissMenus();
    }
  };

  const handleFolderSelect = (folder: WorkspaceFolder) => {
    focusAgentButton();
    setIsFolderPickerOpen(false);
    const bypassPermissions = pendingBypassRef.current;
    pendingBypassRef.current = false;
    transport.send({
      type: 'launchAgent',
      providerId,
      folderPath: folder.path,
      bypassPermissions,
      ...takeNickname(),
    });
  };

  const handleBypassSelect = (bypassPermissions: boolean) => {
    focusAgentButton();
    setIsBypassMenuOpen(false);
    if (hasMultipleFolders) {
      pendingBypassRef.current = bypassPermissions;
      setIsFolderPickerOpen(true);
    } else {
      transport.send({ type: 'launchAgent', providerId, bypassPermissions, ...takeNickname() });
    }
  };

  return (
    // Wraps rather than overflowing a narrow window (overflow would let a
    // focused button scroll the whole office sideways), and stops 90px short
    // of the right edge to stay clear of the version label (bottom-8 right-28).
    <div
      ref={toolbarRef}
      data-testid="bottom-toolbar"
      className="absolute bottom-10 left-10 z-20 flex flex-wrap items-center gap-4 max-w-[calc(100%-90px)] pixel-panel p-4"
    >
      {/* Hide + Agent in standalone browser mode (no terminal to interact with) */}
      {!isBrowserRuntime && (
        <div
          ref={folderPickerRef}
          className="relative"
          onMouseEnter={handleAgentHover}
          onMouseLeave={handleAgentLeave}
          onFocus={handleAgentFocus}
          onBlur={handleAgentBlur}
          onKeyDown={handleAgentKeyDown}
        >
          {providers.length > 1 && (
            <select
              aria-label="Launch provider"
              value={providerId ?? ''}
              onChange={(event) => setChosenProvider(event.target.value)}
              className="text-sm py-4 px-8 bg-btn-bg text-text border-2 border-border rounded-none mr-4"
            >
              {!providerId && <option value="">Configured provider</option>}
              {providers.map((provider) => (
                <option key={provider.providerId} value={provider.providerId}>
                  {provider.displayName}
                </option>
              ))}
            </select>
          )}
          <Button
            ref={agentButtonRef}
            variant="accent"
            onClick={handleAgentClick}
            className={
              isFolderPickerOpen || isBypassMenuOpen
                ? 'bg-accent-bright'
                : 'bg-accent hover:bg-accent-bright'
            }
          >
            + Agent
          </Button>
          <Dropdown isOpen={isBypassMenuOpen}>
            <input
              type="text"
              aria-label="Agent nickname"
              placeholder="Nickname (optional)"
              value={nickname}
              maxLength={AGENT_NICKNAME_MAX_LENGTH}
              onChange={(e) => setNickname(e.target.value)}
              onFocus={() => setIsNicknameFocused(true)}
              onBlur={() => setIsNicknameFocused(false)}
              onKeyDown={(e) => {
                // Typing must not reach the layout editor's shortcuts.
                e.stopPropagation();
                if (e.key === 'Enter') {
                  e.preventDefault();
                  focusAgentButton();
                  handleAgentClick();
                } else if (e.key === 'Escape') {
                  dismissMenus();
                }
              }}
              className="block w-full mb-4 text-sm py-2 px-6 bg-bg-dark border-2 border-border rounded-none text-text"
            />
            <DropdownItem onClick={() => handleBypassSelect(true)}>
              Skip permissions mode <span className="text-2xs text-warning">⚠</span>
            </DropdownItem>
          </Dropdown>
          <Dropdown isOpen={isFolderPickerOpen} className="min-w-128">
            {workspaceFolders.map((folder) => (
              <DropdownItem
                key={folder.path}
                onClick={() => handleFolderSelect(folder)}
                className="text-base"
              >
                {folder.name}
              </DropdownItem>
            ))}
          </Dropdown>
        </div>
      )}
      <Button
        variant={isEditMode ? 'active' : 'default'}
        onClick={onToggleEditMode}
        title="Edit office layout"
      >
        Layout
      </Button>
      <Button
        variant={isEditMode ? 'disabled' : isActivityOpen ? 'active' : 'default'}
        onClick={onToggleActivity}
        disabled={isEditMode}
        title={isEditMode ? 'Close the layout editor to see activity' : 'What every agent is doing'}
        aria-pressed={isActivityOpen}
      >
        Activity
      </Button>
      <Button
        variant={isUsageOpen ? 'active' : 'default'}
        onClick={onToggleUsage}
        title="Token usage"
      >
        Usage
      </Button>
      <Button
        variant={isSettingsOpen ? 'active' : 'default'}
        onClick={onToggleSettings}
        title="Settings"
      >
        Settings
      </Button>
    </div>
  );
}
