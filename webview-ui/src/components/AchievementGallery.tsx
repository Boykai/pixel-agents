import { useEffect, useLayoutEffect, useRef } from 'react';

import type { AchievementProgress } from '../../../core/src/messages.js';
import {
  achievementRows,
  formatAchievementCount,
  progressPercent,
  unlockedCount,
} from '../achievements.js';
import { ACHIEVEMENT_GALLERY_Z_INDEX } from '../constants.js';
import { Modal } from './ui/Modal.js';

interface AchievementGalleryProps {
  isOpen: boolean;
  onClose: () => void;
  /** Progress from the latest achievementsLoaded snapshot plus unlocks since. */
  achievements: readonly AchievementProgress[];
}

/**
 * Every Achievement with its progress, ported from hootbu/pixel-agents
 * (d0843a9). Progress is machine-wide (~/.pixel-agents/achievements.json), so
 * both surfaces and every project show the same gallery.
 */
export function AchievementGallery({ isOpen, onClose, achievements }: AchievementGalleryProps) {
  // Escape closes the gallery and nothing beneath it: Settings, which opened it,
  // stays open. Registered once, at mount, in the capture phase on window, so it
  // runs before every other Escape handler — bubble-phase ones and capture ones
  // added later (the Costume panel's) — and stops the key there.
  const isOpenRef = useRef(isOpen);
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    isOpenRef.current = isOpen;
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !isOpenRef.current) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onCloseRef.current();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  const rows = achievementRows(achievements);
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      zIndex={ACHIEVEMENT_GALLERY_Z_INDEX}
      title={
        <span className="text-achievement">
          Achievements (
          <span data-testid="achievement-count">
            {unlockedCount(rows)}/{rows.length}
          </span>
          )
        </span>
      }
      className="min-w-0! w-[min(420px,calc(100vw-32px))] max-h-[calc(100dvh-32px)] overflow-y-auto pixel-scrollbar"
    >
      <p className="text-xs text-text-muted px-10 m-0 mb-8">Global across all projects</p>
      <ul className="list-none m-0 px-6 pb-6 flex flex-col gap-6" aria-label="Achievements">
        {rows.map((row) => (
          <li
            key={row.id}
            data-testid="achievement-row"
            data-achievement-id={row.id}
            data-unlocked={row.unlocked}
            className={`py-6 px-8 border-2 ${row.unlocked ? 'border-achievement' : 'border-border'}`}
          >
            <div className="flex justify-between items-baseline gap-8">
              <span className={`text-base ${row.unlocked ? 'text-achievement' : 'text-text'}`}>
                {row.unlocked ? '* ' : ''}
                {row.name}
              </span>
              <span className="text-sm text-text-muted shrink-0">
                {formatAchievementCount(row.current)}/{formatAchievementCount(row.target)}
              </span>
            </div>
            <div className="text-xs text-text-muted mt-2">{row.description}</div>
            <div
              role="progressbar"
              aria-label={`${row.name} progress`}
              aria-valuemin={0}
              aria-valuemax={row.target}
              aria-valuenow={row.current}
              className="mt-4 h-4 bg-bg-dark"
            >
              <div
                className="h-full bg-achievement"
                style={{ width: `${progressPercent(row)}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
