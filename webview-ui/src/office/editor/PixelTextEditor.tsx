// Ported from hootbu/pixel-agents (MIT) 69c433f — Copyright (c) 2026 Hootbu (modifications).
// The Sign editor: text, font size, pixel scale and color, with a live preview.
// Adapted to the Modal/Button primitives and theme tokens; its text colors are
// flat hex, so it keeps the fork's swatch + hex picker rather than the HSBC
// ColorPicker (which shifts sprite colors instead of choosing one).
import type { KeyboardEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import { Modal } from '../../components/ui/Modal.js';
import {
  SIGN_COLOR_PRESETS,
  SIGN_DEFAULT_COLOR,
  SIGN_DEFAULT_FONT_SIZE,
  SIGN_FONT_SIZES,
  SIGN_PREVIEW_MAX_ZOOM,
  SIGN_PREVIEW_MIN_HEIGHT_PX,
  SIGN_PREVIEW_MIN_WIDTH_PX,
  SIGN_PREVIEW_PADDING_PX,
  SIGN_PREVIEW_TARGET_WIDTH_PX,
  SIGN_SCALE_MAX,
  SIGN_SCALE_MIN,
  SIGN_TEXT_MAX_LENGTH,
} from '../../constants.js';
import { generateTextSprite } from '../sprites/pixelFont.js';
import { getTextFootprint } from '../sprites/textSpriteCache.js';
import type { SignFontSize, SignText } from '../types.js';

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const SCALES = Array.from(
  { length: SIGN_SCALE_MAX - SIGN_SCALE_MIN + 1 },
  (_, i) => SIGN_SCALE_MIN + i,
);

interface PixelTextEditorProps {
  /** Text to start from: the placed Sign's when editing one, else null (defaults). */
  initialText: SignText | null;
  /** Editing a placed Sign (Update) rather than placing a new one (Place). */
  isEditing: boolean;
  /** Whether a Sign with this text fits where it stands (or will stand). */
  fits: (text: SignText) => boolean;
  onConfirm: (text: SignText) => void;
  onCancel: () => void;
}

export function PixelTextEditor({
  initialText,
  isEditing,
  fits,
  onConfirm,
  onCancel,
}: PixelTextEditorProps) {
  const [value, setValue] = useState(initialText?.value ?? '');
  const [size, setSize] = useState<SignFontSize>(initialText?.size ?? SIGN_DEFAULT_FONT_SIZE);
  const [scale, setScale] = useState(initialText?.scale ?? SIGN_SCALE_MIN);
  const [color, setColor] = useState((initialText?.color ?? SIGN_DEFAULT_COLOR).toUpperCase());
  const [colorInput, setColorInput] = useState(color);
  const inputRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const text: SignText = { value, color, size, scale };
  const hasText = value.trim().length > 0;
  const footprint = hasText ? getTextFootprint(text) : null;
  const fitsHere = hasText && fits(text);

  // Live preview, drawn pixel by pixel from the same sprite the office renders.
  useEffect(() => {
    const canvas = previewRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const sprite = hasText ? generateTextSprite(value, size, color, scale) : [];
    const rows = sprite.length;
    const cols = sprite[0]?.length ?? 0;
    const zoom = Math.max(
      1,
      Math.min(SIGN_PREVIEW_MAX_ZOOM, Math.floor(SIGN_PREVIEW_TARGET_WIDTH_PX / Math.max(cols, 1))),
    );
    canvas.width = Math.max(SIGN_PREVIEW_MIN_WIDTH_PX, cols * zoom + SIGN_PREVIEW_PADDING_PX);
    canvas.height = Math.max(SIGN_PREVIEW_MIN_HEIGHT_PX, rows * zoom + SIGN_PREVIEW_PADDING_PX);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const ox = Math.floor((canvas.width - cols * zoom) / 2);
    const oy = Math.floor((canvas.height - rows * zoom) / 2);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const pixel = sprite[r][c];
        if (!pixel) continue;
        ctx.fillStyle = pixel;
        ctx.fillRect(ox + c * zoom, oy + r * zoom, zoom, zoom);
      }
    }
  }, [hasText, value, size, color, scale]);

  const pickColor = (hex: string) => {
    const upper = hex.toUpperCase();
    setColor(upper);
    setColorInput(upper);
  };

  const handleColorInput = (raw: string) => {
    setColorInput(raw);
    if (HEX_COLOR_RE.test(raw)) setColor(raw.toUpperCase());
  };

  const canConfirm = hasText && fitsHere;
  const confirm = () => {
    if (canConfirm) onConfirm(text);
  };

  // The dialog owns the keyboard: nothing reaches the editor shortcuts (R, T,
  // Delete, Ctrl+Z) while it's open. Enter in a text field confirms.
  const handleKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    } else if (
      e.key === 'Enter' &&
      e.target instanceof HTMLInputElement &&
      e.target.type === 'text'
    ) {
      e.preventDefault();
      confirm();
    }
  };

  return (
    <div onKeyDown={handleKeyDown}>
      <Modal
        isOpen
        onClose={onCancel}
        title={isEditing ? 'Edit Sign' : 'New Sign'}
        className="min-w-0! max-h-[calc(100dvh-32px)] overflow-y-auto"
      >
        <div className="flex flex-col gap-10 px-10 pb-4 w-360 max-w-[calc(100vw-48px)]">
          <label className="flex flex-col gap-4">
            <span className="text-sm text-text-muted">Text</span>
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              maxLength={SIGN_TEXT_MAX_LENGTH}
              placeholder="Enter text..."
              aria-label="Sign text"
              className="w-full text-base py-2 px-6 bg-bg-dark border-2 border-border rounded-none text-text"
            />
          </label>

          <div className="relative flex items-center justify-center">
            <canvas
              ref={previewRef}
              className="block max-w-full bg-bg-dark border-2 border-border [image-rendering:pixelated]"
              aria-label="Sign preview"
            />
            {!hasText && (
              <span className="absolute text-sm text-text-muted pointer-events-none">
                Type something...
              </span>
            )}
          </div>

          <div className="flex flex-col gap-4">
            <span className="text-sm text-text-muted">Font</span>
            <div className="flex gap-4">
              {SIGN_FONT_SIZES.map((option) => (
                <Button
                  key={option}
                  variant={size === option ? 'active' : 'default'}
                  size="sm"
                  onClick={() => setSize(option)}
                  title={`${option} pixel font`}
                >
                  {option}
                </Button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <span className="text-sm text-text-muted">Scale</span>
            <div className="flex gap-4">
              {SCALES.map((option) => (
                <Button
                  key={option}
                  variant={scale === option ? 'active' : 'default'}
                  size="sm"
                  onClick={() => setScale(option)}
                  title={`Pixel scale ${option}x`}
                >
                  {option}x
                </Button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <span className="text-sm text-text-muted">Color</span>
            <div className="flex flex-wrap gap-4">
              {SIGN_COLOR_PRESETS.map((preset) => (
                <button
                  key={preset.hex}
                  type="button"
                  title={preset.label}
                  onClick={() => pickColor(preset.hex)}
                  className={`w-24 h-24 p-0 border-2 rounded-none cursor-pointer ${
                    color === preset.hex.toUpperCase() ? 'border-text' : 'border-border'
                  }`}
                  style={{ background: preset.hex }}
                />
              ))}
            </div>
            <div className="flex items-center gap-6">
              <input
                type="color"
                value={color.toLowerCase()}
                onChange={(e) => pickColor(e.target.value)}
                title="Custom sign color"
                className="w-32 h-32 p-0 border-2 border-border bg-transparent cursor-pointer"
              />
              <input
                type="text"
                value={colorInput}
                onChange={(e) => handleColorInput(e.target.value)}
                placeholder={SIGN_DEFAULT_COLOR}
                aria-label="Sign color hex"
                className="w-110 text-sm py-2 px-6 bg-bg-dark border-2 border-border rounded-none text-text"
              />
            </div>
          </div>

          {footprint && (
            <div className="text-sm text-text-muted">
              Size: {footprint.w} x {footprint.h} tiles
              {!fitsHere && <span className="text-warning"> — doesn't fit here</span>}
            </div>
          )}

          <div className="flex justify-end gap-8">
            <Button variant="default" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              variant={canConfirm ? 'accent' : 'disabled'}
              size="sm"
              disabled={!canConfirm}
              onClick={confirm}
              title={isEditing ? 'Update sign' : 'Place sign'}
            >
              {isEditing ? 'Update' : 'Place'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
