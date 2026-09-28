import type { Frame, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';

/** Sprite pixels per tile edge; the zoom label shows zoom × this, e.g. "48px". */
export const TILE_SIZE_PX = 16;

/** The webview debounces `setZoom` by 500 ms; give a stray write time to land. */
export const ZOOM_SAVE_SETTLE_MS = 1_500;

type ZoomSurface = Frame | Page;

interface ZoomHooksWindow extends Window {
  __pixelAgentsTestHooks?: { getZoom?: () => number };
}

/** The live integer zoom, read through the `getZoom` e2e hook App.tsx registers. */
export async function readZoom(surface: ZoomSurface): Promise<number | null> {
  return surface.evaluate(
    () => (window as ZoomHooksWindow).__pixelAgentsTestHooks?.getZoom?.() ?? null,
  );
}

/** The zoom persisted for one adapter namespace in the isolated HOME's config.json. */
export function readStoredZoom(tmpHome: string, namespace: 'vscode' | 'standalone'): unknown {
  const configPath = path.join(tmpHome, '.pixel-agents', 'config.json');
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<
      string,
      Record<string, unknown> | undefined
    >;
    return config[namespace]?.zoom;
  } catch {
    return undefined;
  }
}
