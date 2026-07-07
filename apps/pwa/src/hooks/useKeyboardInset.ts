// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useEffect, useState } from 'react';

/**
 * Height (px) of the on-screen keyboard currently covering the bottom of the
 * viewport, or 0 if none. `100dvh` on iOS Safari does NOT shrink when the
 * software keyboard opens (only Android + `interactive-widget=resizes-content`
 * does), so a `position: fixed` layout pinned to `100dvh` ends up with its
 * bottom content — e.g. a chat input bar — hidden behind the keyboard.
 *
 * `visualViewport.height` does shrink correctly on iOS, so the gap between
 * `window.innerHeight` (unaffected by the keyboard) and the visual viewport's
 * visible bottom edge (`height + offsetTop`) is the keyboard's height. On
 * Android with `resizes-content`, `innerHeight` already shrinks in lockstep
 * with the visual viewport, so this resolves to 0 there — safe to use on
 * both platforms.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      setInset(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  return inset;
}
