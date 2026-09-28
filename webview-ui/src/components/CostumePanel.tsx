import type { CSSProperties } from 'react';
import { useEffect, useState } from 'react';

import { AGENT_NICKNAME_MAX_LENGTH } from '../../../core/src/constants.js';
import { normalizeNickname } from '../../../core/src/normalizeNickname.js';
import {
  COSTUME_GRID_COLUMNS,
  COSTUME_HUE_MAX_DEG,
  COSTUME_HUE_STEP_DEG,
  COSTUME_PREVIEW_HEIGHT_PX,
  COSTUME_PREVIEW_WIDTH_PX,
  COSTUME_PREVIEW_ZOOM,
} from '../constants.js';
import { getCachedSprite } from '../office/sprites/spriteCache.js';
import { getCharacterSprites, getLoadedCharacterCount } from '../office/sprites/spriteData.js';
import { Direction } from '../office/types.js';
import { Button } from './ui/Button.js';
import { ItemSelect } from './ui/ItemSelect.js';

interface CostumePanelProps {
  currentPalette: number;
  currentHueShift: number;
  nickname: string;
  /** Applied live on every pick; the panel keeps no draft. */
  onSelect: (palette: number, hueShift: number) => void;
  /** '' clears the nickname. */
  onRename: (nickname: string) => void;
  onClose: () => void;
}

/**
 * The Costume panel: pick a selected agent's palette (previewed in its idle pose
 * through the shared sprite cache) and hue shift, and name it. Every change
 * applies to the character at once, so the office itself is the preview.
 */
export function CostumePanel({
  currentPalette,
  currentHueShift,
  nickname,
  onSelect,
  onRename,
  onClose,
}: CostumePanelProps) {
  const [selectedPalette, setSelectedPalette] = useState(currentPalette);
  const [hueShift, setHueShift] = useState(currentHueShift);
  const [nicknameDraft, setNicknameDraft] = useState(nickname);

  // Escape closes only this panel: capture phase, so the agent details'
  // own Escape handler (bubble phase, same window) never sees it.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  const handlePaletteClick = (palette: number) => {
    setSelectedPalette(palette);
    // A new palette starts from its own colors.
    setHueShift(0);
    onSelect(palette, 0);
  };

  const handleHueShiftChange = (value: number) => {
    setHueShift(value);
    onSelect(selectedPalette, value);
  };

  const commitNickname = () => {
    if (normalizeNickname(nicknameDraft) !== nickname) onRename(nicknameDraft);
  };

  const paletteCount = getLoadedCharacterCount();
  const hueFill = (hueShift / COSTUME_HUE_MAX_DEG) * 100;

  return (
    <section
      aria-label="Costume"
      data-testid="costume-panel"
      className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 max-w-[calc(100%-16px)] max-h-[calc(100%-16px)] overflow-y-auto pixel-scrollbar pixel-panel p-10 flex flex-col gap-8"
    >
      <div className="flex items-center justify-between gap-12">
        <h2 className="m-0 text-xl leading-none text-accent-bright">Choose Costume</h2>
        <Button variant="ghost" size="icon" onClick={onClose} title="Close" aria-label="Close">
          x
        </Button>
      </div>
      <label className="flex items-center gap-8 text-sm text-text-muted">
        Nickname
        <input
          type="text"
          value={nicknameDraft}
          placeholder="Nickname (optional)"
          maxLength={AGENT_NICKNAME_MAX_LENGTH}
          onChange={(e) => setNicknameDraft(e.target.value)}
          onBlur={commitNickname}
          onKeyDown={(e) => {
            // Typing must not reach the layout editor's shortcuts.
            if (e.key !== 'Escape') e.stopPropagation();
            if (e.key === 'Enter') {
              e.preventDefault();
              commitNickname();
            }
          }}
          className="flex-1 min-w-0 text-sm py-2 px-6 bg-bg-dark border-2 border-border rounded-none text-text"
        />
      </label>
      <div
        className="grid gap-6 justify-center"
        style={{ gridTemplateColumns: `repeat(${COSTUME_GRID_COLUMNS}, max-content)` }}
      >
        {Array.from({ length: paletteCount }, (_, palette) => {
          // Only the worn palette previews the hue shift.
          const previewHue = palette === selectedPalette ? hueShift : 0;
          return (
            <ItemSelect
              key={palette}
              width={COSTUME_PREVIEW_WIDTH_PX}
              height={COSTUME_PREVIEW_HEIGHT_PX}
              selected={palette === selectedPalette}
              onClick={() => handlePaletteClick(palette)}
              title={`Costume ${palette + 1}`}
              deps={[palette, previewHue]}
              draw={(ctx, w, h) => {
                // walk[DOWN][1] is the standing pose.
                const sprite = getCharacterSprites(palette, previewHue).walk[Direction.DOWN][1];
                const cached = getCachedSprite(sprite, COSTUME_PREVIEW_ZOOM);
                ctx.drawImage(
                  cached,
                  Math.floor((w - cached.width) / 2),
                  Math.floor((h - cached.height) / 2),
                );
              }}
            />
          );
        })}
      </div>
      <label className="flex items-center gap-8 text-sm text-text-muted">
        Hue
        <input
          type="range"
          aria-label="Hue shift"
          min={0}
          max={COSTUME_HUE_MAX_DEG}
          step={COSTUME_HUE_STEP_DEG}
          value={hueShift}
          onChange={(e) => handleHueShiftChange(Number(e.target.value))}
          className="pixel-range flex-1 min-w-0"
          style={{ '--range-fill': `${hueFill}%` } as CSSProperties}
        />
        <span className="w-44 text-right text-text tabular-nums">{hueShift}°</span>
      </label>
    </section>
  );
}
