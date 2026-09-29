import { useCallback, useEffect, useState } from 'react';

import { toMajorMinor } from '../changelogData.ts';
import {
  BESIDE_BOTTOM_TOOLBAR_REACH_VAR,
  WHATS_NEW_AUTO_CLOSE_MS,
  WHATS_NEW_FADE_MS,
} from '../constants.ts';
import { Button } from './ui/Button.js';

interface VersionIndicatorProps {
  currentVersion: string;
  lastSeenVersion: string;
  onDismiss: () => void;
  onOpenChangelog: () => void;
}

/** Ref callback for a popup anchored beside the BottomToolbar: publishes how
 *  far it reaches in from the app root's right edge, which
 *  `.beside-bottom-toolbar` compares with the toolbar's right edge. Its width
 *  doesn't depend on how high it sits, so moving it up can't loop back. */
function publishReachBesideToolbar(element: HTMLDivElement | null): (() => void) | undefined {
  if (!element) return undefined;
  const publish = () => {
    const root = element.offsetParent;
    if (!(root instanceof HTMLElement)) return;
    const reach = root.clientWidth - element.offsetLeft;
    element.style.setProperty(BESIDE_BOTTOM_TOOLBAR_REACH_VAR, `${reach}px`);
  };
  publish();
  const observer = new ResizeObserver(publish);
  observer.observe(element);
  return () => observer.disconnect();
}

export function VersionIndicator({
  currentVersion,
  lastSeenVersion,
  onDismiss,
  onOpenChangelog,
}: VersionIndicatorProps) {
  const [dismissed, setDismissed] = useState(false);
  const [fading, setFading] = useState(false);
  const [labelHovered, setLabelHovered] = useState(false);

  const currentMajorMinor = toMajorMinor(currentVersion);
  const isUnseen = currentMajorMinor !== lastSeenVersion;
  const showUpdateNotice = isUnseen && !dismissed;

  // Start fade-out after auto-close delay, then fully dismiss after the transition
  useEffect(() => {
    if (!showUpdateNotice || fading) return;
    const fadeTimer = setTimeout(() => setFading(true), WHATS_NEW_AUTO_CLOSE_MS);
    return () => clearTimeout(fadeTimer);
  }, [showUpdateNotice, fading]);

  useEffect(() => {
    if (!fading) return;
    const removeTimer = setTimeout(() => {
      setDismissed(true);
      onDismiss();
    }, WHATS_NEW_FADE_MS);
    return () => clearTimeout(removeTimer);
  }, [fading, onDismiss]);

  const handleDismiss = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setDismissed(true);
      onDismiss();
    },
    [onDismiss],
  );

  const handleOpenChangelog = useCallback(() => {
    setDismissed(true);
    onOpenChangelog();
  }, [onOpenChangelog]);

  if (!currentVersion) return null;

  return (
    <>
      {/* Update notice — shown once per version until dismissed or auto-closed.
          It sits beside the BottomToolbar, and stacks above it once a narrow
          window would put the two on top of each other. */}
      {showUpdateNotice && (
        <div
          ref={publishReachBesideToolbar}
          data-testid="whats-new-notice"
          onClick={handleOpenChangelog}
          className="absolute beside-bottom-toolbar right-28 z-20 pixel-panel px-10 pt-8 pb-9 cursor-pointer flex flex-col gap-8 max-w-2xs"
          style={{
            opacity: fading ? 0 : 1,
            transition: `opacity ${WHATS_NEW_FADE_MS / 1000}s ease-out`,
          }}
        >
          <div className="flex justify-between items-center gap-10">
            <span className="text-lg text-accent-bright leading-none">
              Updated to v{currentMajorMinor}!
            </span>
            <Button variant="ghost" size="icon" onClick={handleDismiss} className="leading-none">
              x
            </Button>
          </div>
          <span className="text-sm whitespace-nowrap">See what's new</span>
        </div>
      )}
      {/* Hover tooltip — "See what's new" appears on label hover after notice is gone */}
      {!showUpdateNotice && labelHovered && (
        <div
          ref={publishReachBesideToolbar}
          onClick={handleOpenChangelog}
          className="absolute beside-bottom-toolbar right-28 z-20 pixel-panel py-6 px-12 cursor-pointer text-sm whitespace-nowrap"
        >
          See what's new!
        </div>
      )}
      {/* Version label — always visible */}
      <div
        onMouseEnter={() => setLabelHovered(true)}
        onMouseLeave={() => setLabelHovered(false)}
        onClick={handleOpenChangelog}
        className="absolute bottom-8 right-28 z-20 text-lg cursor-pointer select-none pr-2 transition-opacity duration-200"
        style={{ opacity: labelHovered ? 0.8 : 0.4 }}
      >
        v{currentMajorMinor}
      </div>
    </>
  );
}
