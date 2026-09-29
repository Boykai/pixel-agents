import { useEffect, useState } from 'react';

import { getAchievement } from '../../../core/src/achievements.js';
import type { AchievementPopupView } from '../achievements.js';
import { ACHIEVEMENT_POPUP_FADE_MS, ACHIEVEMENT_POPUP_Z_INDEX } from '../constants.js';

interface AchievementPopupProps {
  /** What the AchievementPopupQueue has on screen; null when nothing is. */
  popup: AchievementPopupView | null;
}

/**
 * Top-right toast announcing an unlocked Achievement, ported from
 * hootbu/pixel-agents (d0843a9). The live region stays mounted so each popup
 * is announced as it lands; clicks pass through to the office. The width
 * leaves the zoom buttons (top-left) uncovered however narrow the panel is.
 */
export function AchievementPopup({ popup }: AchievementPopupProps) {
  const definition = popup ? getAchievement(popup.id) : undefined;
  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute top-8 right-8 max-w-[min(320px,calc(100%-64px))] pointer-events-none"
      style={{ zIndex: ACHIEVEMENT_POPUP_Z_INDEX }}
    >
      {popup && definition && (
        <PopupCard
          key={popup.id}
          id={popup.id}
          name={definition.name}
          description={definition.description}
          leaving={popup.leaving}
        />
      )}
    </div>
  );
}

interface PopupCardProps {
  id: string;
  name: string;
  description: string;
  leaving: boolean;
}

function PopupCard({ id, name, description, leaving }: PopupCardProps) {
  // Mounted hidden and revealed a frame later, so the slide-in transitions.
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const shown = entered && !leaving;

  return (
    <div
      data-testid="achievement-popup"
      data-achievement-id={id}
      className={`pixel-panel border-achievement flex items-center gap-10 py-8 px-14 transition-[opacity,transform] ease-out motion-reduce:transition-none ${shown ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-20'}`}
      style={{ transitionDuration: `${ACHIEVEMENT_POPUP_FADE_MS}ms` }}
    >
      <span aria-hidden="true" className="text-2xl text-achievement leading-none">
        *
      </span>
      <div className="min-w-0">
        <div className="text-2xs text-text-muted">Achievement unlocked</div>
        <div className="text-base text-achievement">{name}</div>
        <div className="text-xs text-text-muted">{description}</div>
      </div>
    </div>
  );
}
